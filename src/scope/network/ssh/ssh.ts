/* eslint max-classes-per-file: 0 */
import SSH2 from 'ssh2';
import R from 'ramda';
import * as os from 'os';
import merge from 'lodash.merge';
import { userpass as promptUserpass } from '../../../prompts';
import keyGetter from './key-getter';
import ComponentObjects from '../../component-objects';
import {
  RemoteScopeNotFound,
  UnexpectedNetworkError,
  AuthenticationFailed,
  PermissionDenied,
  SSHInvalidResponse,
  OldClientVersion
} from '../exceptions';
import { BitIds, BitId } from '../../../bit-id';
import { toBase64, packCommand, buildCommandMessage, unpackCommand } from '../../../utils';
import ComponentNotFound from '../../../scope/exceptions/component-not-found';
import { ScopeDescriptor } from '../../scope';
import ConsumerComponent from '../../../consumer/component';
import checkVersionCompatibilityFunction from '../check-version-compatibility';
import logger from '../../../logger/logger';
import { Network } from '../network';
import { DEFAULT_SSH_READY_TIMEOUT, CFG_USER_TOKEN_KEY, CFG_SSH_NO_COMPRESS } from '../../../constants';
import RemovedObjects from '../../removed-components';
import MergeConflictOnRemote from '../../exceptions/merge-conflict-on-remote';
import { Analytics } from '../../../analytics/analytics';
import { getSync } from '../../../api/consumer/lib/global-config';
import GeneralError from '../../../error/general-error';
import { ListScopeResult } from '../../../consumer/component/components-list';
import CustomError from '../../../error/custom-error';
import ExportAnotherOwnerPrivate from '../exceptions/export-another-owner-private';
import DependencyGraph from '../../graph/scope-graph';
import globalFlags from '../../../cli/global-flags';
import * as globalConfig from '../../../api/consumer/lib/global-config';
import { ComponentLogs } from '../../models/model-component';

const checkVersionCompatibility = R.once(checkVersionCompatibilityFunction);
const AUTH_FAILED_MESSAGE = 'All configured authentication methods failed';
const PASSPHRASE_POSSIBLY_MISSING_MESSAGE = 'Cannot parse privateKey: Unsupported key format';

function absolutePath(path: string) {
  if (!path.startsWith('/')) return `~/${path}`;
  return path;
}

function clean(str: string) {
  return str.replace('\n', '');
}

export type SSHProps = {
  path: string;
  username: string;
  port: number;
  host: string;
};

export type SSHConnectionStrategyName = 'token' | 'ssh-agent' | 'ssh-key' | 'user-password' | 'anonymous';

class AuthenticationStrategyFailed extends Error {}

export const DEFAULT_STRATEGIES: SSHConnectionStrategyName[] = ['token', 'ssh-agent', 'ssh-key', 'user-password'];
export const DEFAULT_READ_STRATEGIES: SSHConnectionStrategyName[] = [
  'token',
  'ssh-agent',
  'ssh-key',
  'anonymous',
  'user-password'
];
export default class SSH implements Network {
  connection: SSH2 | null | undefined;
  path: string;
  username: string;
  port: number;
  host: string;
  _sshUsername?: string; // Username entered by the user on the prompt user/pass process

  constructor({ path, username, port, host }: SSHProps) {
    this.path = path;
    this.username = username;
    this.port = port;
    this.host = host || '';
  }

  /**
   * Network strategies:
   * 1) token (generated by bit-login command)
   * 2) ssh-agent (public-key should be saved on bit.dev, user needs to enable ssh-agent in its os. the agent saves the passphrase, so no need to enter)
   * 3) ssh-key. (user can specify location by `bit config`, if not, the default one is used. doesn't support passphrase)
   * 4) anonymous. (for read operations only) - trying to do the action as anonymous user
   * 5) prompt of user/password
   */
  async connect(strategiesNames: SSHConnectionStrategyName[] = DEFAULT_STRATEGIES): Promise<SSH> {
    const strategies: { [key: string]: Function } = {
      token: this._tokenAuthentication,
      anonymous: this._anonymousAuthentication,
      'ssh-agent': this._sshAgentAuthentication,
      'ssh-key': this._sshKeyAuthentication,
      'user-password': this._userPassAuthentication
    };
    const strategiesFailures: string[] = [];
    for (const strategyName of strategiesNames) {
      logger.debug(`ssh, trying to connect using ${strategyName}`);
      const strategyFunc = strategies[strategyName].bind(this);
      try {
        const strategyResult = await strategyFunc(); // eslint-disable-line
        if (strategyResult) return strategyResult as SSH;
      } catch (err) {
        logger.debug(`ssh, failed to connect using ${strategyName}. ${err.message}`);
        if (err instanceof AuthenticationStrategyFailed) {
          strategiesFailures.push(err.message);
        } else {
          throw err;
        }
      }
    }
    logger.errorAndAddBreadCrumb('ssh', 'all connection strategies have been failed!');
    strategiesFailures.unshift('The following strategies were failed');
    throw new AuthenticationFailed(strategiesFailures.join('\n[-] '));
  }

  async _tokenAuthentication(): Promise<SSH> {
    const sshConfig = this._composeTokenAuthObject();
    if (!sshConfig) {
      throw new AuthenticationStrategyFailed(
        'user token not defined in bit-config. please run `bit login` to authenticate.'
      );
    }
    const authFailedMsg =
      'failed to authenticate with user token. generate a new token by running `bit logout && bit login`.';
    return this._connectWithConfig(sshConfig, 'token', authFailedMsg);
  }
  async _anonymousAuthentication(): Promise<SSH> {
    const sshConfig = this._composeAnonymousAuthObject();
    if (!sshConfig) {
      throw new AuthenticationStrategyFailed('could not create the anonymous ssh configuration.');
    }
    const authFailedMsg = 'collection might be private.';
    return this._connectWithConfig(sshConfig, 'anonymous', authFailedMsg);
  }
  async _sshAgentAuthentication(): Promise<SSH> {
    if (!this._hasAgentSocket()) {
      throw new AuthenticationStrategyFailed(
        'unable to get SSH keys from ssh-agent to. perhaps service is down or disabled.'
      );
    }
    const sshConfig = merge(this._composeBaseObject(), { agent: process.env.SSH_AUTH_SOCK });
    const authFailedMsg = 'no matching private key found in ssh-agent to authenticate to remote server.';
    return this._connectWithConfig(sshConfig, 'ssh-agent', authFailedMsg);
  }
  async _sshKeyAuthentication(): Promise<SSH> {
    const keyBuffer = await keyGetter();
    if (!keyBuffer) {
      throw new AuthenticationStrategyFailed(
        'SSH key not found in `~/.ssh/id_rsa` or `ssh_key_file` config in `bit config` either not configured or refers to wrong path.'
      );
    }
    const sshConfig = merge(this._composeBaseObject(), { privateKey: keyBuffer });
    const authFailedMsg = 'failed connecting to remote server using `~/.ssh/id_rsa` or `ssh_key_file` in `bit config`.';
    return this._connectWithConfig(sshConfig, 'ssh-key', authFailedMsg);
  }
  async _userPassAuthentication(): Promise<SSH> {
    const sshConfig = await this._composeUserPassObject();
    const authFailedMsg = 'unable to connect using provided username and password combination.';
    return this._connectWithConfig(sshConfig, 'user-password', authFailedMsg);
  }

  close() {
    this.connection.end();
    return this;
  }

  _composeBaseObject(passphrase?: string) {
    return {
      username: this.username,
      host: this.host,
      port: this.port,
      passphrase,
      readyTimeout: DEFAULT_SSH_READY_TIMEOUT
    };
  }
  _composeTokenAuthObject(): Record<string, any> | null | undefined {
    const processToken = globalFlags.token;
    const token = processToken || getSync(CFG_USER_TOKEN_KEY);
    if (token) {
      this._sshUsername = 'token';
      return merge(this._composeBaseObject(), { username: 'token', password: token });
    }
    return null;
  }
  _composeAnonymousAuthObject(): Record<string, any> | null | undefined {
    this._sshUsername = 'anonymous';
    return merge(this._composeBaseObject(), { username: 'anonymous', password: '' });
  }
  _composeUserPassObject() {
    // @ts-ignore
    return promptUserpass().then(({ username, password }) => {
      Analytics.setExtraData('authentication_method', 'user_password');
      this._sshUsername = username;
      return merge(this._composeBaseObject(), { username, password });
    });
  }
  _hasAgentSocket() {
    return !!process.env.SSH_AUTH_SOCK;
  }
  async _connectWithConfig(
    sshConfig: Record<string, any>,
    authenticationType: string,
    authFailedMsg: string
  ): Promise<SSH> {
    const connectWithConfigP = () => {
      const conn = new SSH2();
      return new Promise((resolve, reject) => {
        conn
          .on('error', err => {
            reject(err);
          })
          .on('ready', () => {
            resolve(conn);
          })
          .connect(sshConfig);
      });
    };
    try {
      this.connection = await connectWithConfigP();
      Analytics.setExtraData('authentication_method', authenticationType);
      logger.debug(`ssh, authenticated successfully using ${authenticationType}`);
      return this;
    } catch (err) {
      if (err.message === AUTH_FAILED_MESSAGE) {
        throw new AuthenticationStrategyFailed(authFailedMsg);
      }
      logger.error('ssh', err);
      if (err.code === 'ENOTFOUND') {
        throw new GeneralError(
          `unable to find the SSH server. host: ${err.host}, port: ${err.port}. Original error message: ${err.message}`
        );
      }
      if (err.message === PASSPHRASE_POSSIBLY_MISSING_MESSAGE) {
        const macMojaveOs = process.platform === 'darwin' && os.release() === '18.2.0';
        let passphrasePossiblyMissing =
          'error connecting with private ssh key. in case passphrase is used, use ssh-agent.';
        if (macMojaveOs) {
          passphrasePossiblyMissing +=
            ' for macOS Mojave users, use `-m PEM` for `ssh-keygen` command to generate a valid SSH key';
        }
        throw new AuthenticationStrategyFailed(passphrasePossiblyMissing);
      }
      throw new AuthenticationStrategyFailed(`${authFailedMsg} due to an error "${err.message}"`);
    }
  }

  buildCmd(commandName: string, path: string, payload: any, context: any): string {
    const compress = globalConfig.getSync(CFG_SSH_NO_COMPRESS) !== 'true';
    return `bit ${commandName} ${toBase64(path)} ${packCommand(
      buildCommandMessage(payload, context, compress),
      true,
      compress
    )}`;
  }

  exec(commandName: string, payload?: any, context?: Record<string, any>): Promise<any> {
    logger.debug(`ssh: going to run a remote command ${commandName}, path: ${this.path}`);
    // Add the entered username to context
    if (this._sshUsername) {
      context = context || {};
      context.sshUsername = this._sshUsername;
    }
    // eslint-disable-next-line consistent-return
    return new Promise((resolve, reject) => {
      let res = '';
      let err;
      // No need to use packCommand on the payload in case of put command
      // because we handle all the base64 stuff in a better way inside the ComponentObjects.manyToString
      // inside pushMany function here
      const cmd = this.buildCmd(
        commandName,
        absolutePath(this.path || ''),
        commandName === '_put' ? null : payload,
        context
      );
      if (!this.connection) {
        err = 'ssh connection is not defined';
        logger.error('ssh', err);
        return reject(err);
      }
      // eslint-disable-next-line consistent-return
      this.connection.exec(cmd, (error, stream) => {
        if (error) {
          logger.error('ssh, exec returns an error: ', error);
          return reject(error);
        }
        if (commandName === '_put') {
          stream.stdin.write(payload);
          stream.stdin.end();
        }
        stream
          .on('data', response => {
            res += response.toString();
          })
          .on('exit', code => {
            logger.debug(`ssh: exit. Exit code: ${code}`);
            const promiseExit = () => {
              return code && code !== 0 ? reject(this.errorHandler(code, err)) : resolve(clean(res));
            };
            // sometimes the connection 'exit' before 'close' and then it doesn't have the data (err) ready yet.
            // in that case, we prefer to wait until the onClose will terminate the promise.
            // sometimes though, the connection only 'exit' and never 'close' (happened when _put command sent back
            // more than 1MB of data), in that case, the following setTimeout will terminate the promise.
            setTimeout(promiseExit, 2000);
          })
          .on('close', (code, signal) => {
            if (commandName === '_put') res = res.replace(payload, '');
            logger.debug(`ssh: returned with code: ${code}, signal: ${signal}.`);
            // DO NOT CLOSE THE CONNECTION (using this.connection.end()), it causes bugs when there are several open
            // connections. Same bugs occur when running "this.connection.end()" on "end" or "exit" events.
            return code && code !== 0 ? reject(this.errorHandler(code, err)) : resolve(clean(res));
          })
          .stderr.on('data', response => {
            err = response.toString();
            logger.error(`ssh: got an error, ${err}`);
          });
      });
    });
  }

  // eslint-disable-next-line complexity
  errorHandler(code: number, err: string) {
    let parsedError;
    try {
      const { headers, payload } = this._unpack(err, false);
      checkVersionCompatibility(headers.version);
      parsedError = payload;
    } catch (e) {
      // be graceful when can't parse error message
      logger.error(`ssh: failed parsing error as JSON, error: ${err}`);
    }

    switch (code) {
      default:
        return new UnexpectedNetworkError(parsedError ? parsedError.message : err);
      case 127:
        return new ComponentNotFound((parsedError && parsedError.id) || err);
      case 128:
        return new PermissionDenied(`${this.host}:${this.path}`);
      case 129:
        return new RemoteScopeNotFound((parsedError && parsedError.name) || err);
      case 130:
        return new PermissionDenied(`${this.host}:${this.path}`);
      case 131:
        return new MergeConflictOnRemote(parsedError && parsedError.idsAndVersions ? parsedError.idsAndVersions : []);
      case 132:
        return new CustomError(parsedError && parsedError.message ? parsedError.message : err);
      case 133:
        return new OldClientVersion(parsedError && parsedError.message ? parsedError.message : err);
      case 134: {
        const msg = parsedError && parsedError.message ? parsedError.message : err;
        const sourceScope = parsedError && parsedError.sourceScope ? parsedError.sourceScope : 'unknown';
        const destinationScope = parsedError && parsedError.destinationScope ? parsedError.destinationScope : 'unknown';
        return new ExportAnotherOwnerPrivate(msg, sourceScope, destinationScope);
      }
    }
  }

  _unpack(data, base64 = true) {
    try {
      const unpacked = unpackCommand(data, base64);
      return unpacked;
    } catch (err) {
      logger.error(`unpackCommand found on error "${err}", while parsing the following string: ${data}`);
      throw new SSHInvalidResponse(data);
    }
  }

  pushMany(manyComponentObjects: ComponentObjects[], context?: Record<string, any>): Promise<string[]> {
    // This ComponentObjects.manyToString will handle all the base64 stuff so we won't send this payload
    // to the pack command (to prevent duplicate base64)
    return this.exec('_put', ComponentObjects.manyToString(manyComponentObjects), context).then((data: string) => {
      const { payload, headers } = this._unpack(data);
      checkVersionCompatibility(headers.version);
      return payload.ids;
    });
  }

  deleteMany(
    ids: string[],
    force: boolean,
    context?: Record<string, any>
  ): Promise<ComponentObjects[] | RemovedObjects> {
    return this.exec(
      '_delete',
      {
        bitIds: ids,
        force
      },
      context
    ).then((data: string) => {
      const { payload } = this._unpack(data);
      return RemovedObjects.fromObjects(payload);
    });
  }
  deprecateMany(ids: string[], context?: Record<string, any>): Promise<ComponentObjects[]> {
    return this.exec(
      '_deprecate',
      {
        ids
      },
      context
    ).then((data: string) => {
      const { payload } = this._unpack(data);
      return payload;
    });
  }
  undeprecateMany(ids: string[], context?: Record<string, any>): Promise<ComponentObjects[]> {
    return this.exec(
      '_undeprecate',
      {
        ids
      },
      context
    ).then((data: string) => {
      const { payload } = this._unpack(data);
      return payload;
    });
  }
  push(componentObjects: ComponentObjects): Promise<string[]> {
    return this.pushMany([componentObjects]);
  }

  describeScope(): Promise<ScopeDescriptor> {
    return this.exec('_scope')
      .then(data => {
        const { payload, headers } = this._unpack(data);
        checkVersionCompatibility(headers.version);
        return payload;
      })
      .catch(() => {
        throw new RemoteScopeNotFound(this.path);
      });
  }

  async list(namespacesUsingWildcards?: string): Promise<ListScopeResult[]> {
    return this.exec('_list', namespacesUsingWildcards).then(async (str: string) => {
      const { payload, headers } = this._unpack(str);
      checkVersionCompatibility(headers.version);
      payload.forEach(result => {
        result.id = new BitId(result.id);
      });
      return payload;
    });
  }

  latestVersions(componentIds: BitId[]): Promise<string[]> {
    const componentIdsStr = componentIds.map(componentId => componentId.toString());
    return this.exec('_latest', componentIdsStr).then((str: string) => {
      const { payload, headers } = this._unpack(str);
      checkVersionCompatibility(headers.version);
      return payload;
    });
  }

  search(query: string, reindex: boolean) {
    return this.exec('_search', { query, reindex: reindex.toString() }).then(data => {
      const { payload, headers } = this._unpack(data);
      checkVersionCompatibility(headers.version);
      return payload;
    });
  }

  show(id: BitId): Promise<ConsumerComponent | null | undefined> {
    return this.exec('_show', id.toString()).then((str: string) => {
      const { payload, headers } = this._unpack(str);
      checkVersionCompatibility(headers.version);
      return str ? ConsumerComponent.fromString(payload) : null;
    });
  }

  log(id: BitId): Promise<ComponentLogs> {
    return this.exec('_log', id.toString()).then((str: string) => {
      const { payload, headers } = this._unpack(str);
      checkVersionCompatibility(headers.version);
      return str ? JSON.parse(payload) : null;
    });
  }

  graph(bitId?: BitId): Promise<DependencyGraph> {
    const idStr = bitId ? bitId.toString() : '';
    return this.exec('_graph', idStr).then((str: string) => {
      const { payload, headers } = this._unpack(str);
      checkVersionCompatibility(headers.version);
      return DependencyGraph.loadFromString(payload);
    });
  }

  async fetch(ids: BitIds, noDeps = false, context?: Record<string, any>): Promise<ComponentObjects[]> {
    let options = '';
    const idsStr = ids.serialize();
    if (noDeps) options = '--no-dependencies';
    return this.exec(`_fetch ${options}`, idsStr, context).then((str: string) => {
      const parseResponse = () => {
        try {
          const results = JSON.parse(str);
          return results;
        } catch (err) {
          throw new SSHInvalidResponse(str);
        }
      };
      const { payload, headers } = parseResponse();
      checkVersionCompatibility(headers.version);
      const componentObjects = ComponentObjects.manyFromString(payload);
      return componentObjects;
    });
  }
}
