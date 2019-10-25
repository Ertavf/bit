import { isBitUrl, cleanBang } from '../utils';
import ComponentObjects from '../scope/component-objects';
import { connect } from '../scope/network';
import { InvalidRemote } from './exceptions';
import { BitId, BitIds } from '../bit-id';
import { Network } from '../scope/network/network';
import Component from '../consumer/component/consumer-component';
import { ListScopeResult } from '../consumer/component/components-list';
import { SSHConnectionStrategyName } from '../scope/network/ssh/ssh';
import DependencyGraph from '../scope/graph/scope-graph';

/**
 * @ctx bit, primary, remote
 */
function isPrimary(alias: string): boolean {
  return alias.includes('!');
}

export default class Remote {
  primary = false;
  host: string;
  name: string;

  constructor(host: string, name: string | null | undefined, primary = false) {
    this.name = name || '';
    this.host = host;
    this.primary = primary;
  }

  connect(strategiesNames?: SSHConnectionStrategyName[]): Promise<Network> {
    return connect(
      this.host,
      strategiesNames
    );
  }

  toPlainObject() {
    return {
      host: this.host,
      name: this.name
    };
  }

  scope(): Promise<{ name: string }> {
    return this.connect().then(network => {
      return network.describeScope();
    });
  }

  list(namespacesUsingWildcards?: string, strategiesNames?: SSHConnectionStrategyName[]): Promise<ListScopeResult[]> {
    return this.connect(strategiesNames).then(network => network.list(namespacesUsingWildcards));
  }

  search(query: string, reindex: boolean): Promise<any> {
    return this.connect().then(network => network.search(query, reindex));
  }

  show(bitId: BitId): Promise<Component | null | undefined> {
    return this.connect().then(network => network.show(bitId));
  }

  graph(bitId?: BitId | null | undefined): Promise<DependencyGraph> {
    // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
    return this.connect().then(network => network.graph(bitId));
  }

  fetch(
    bitIds: BitIds,
    withoutDeps: boolean,
    context: Record<string, any> | null | undefined
  ): Promise<ComponentObjects[]> {
    // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
    return this.connect().then(network => network.fetch(bitIds, withoutDeps, context));
  }

  latestVersions(bitIds: BitId[]): Promise<ComponentObjects[]> {
    // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
    return this.connect().then(network => network.latestVersions(bitIds));
  }

  validate() {
    if (!isBitUrl(this.host)) throw new InvalidRemote();
  }

  push(componentObjects: ComponentObjects): Promise<ComponentObjects> {
    // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
    return connect(this.host).then(network => network.push(componentObjects));
  }

  pushMany(components: ComponentObjects[], context: Record<string, any> | null | undefined): Promise<string[]> {
    // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
    return connect(this.host).then(network => network.pushMany(components, context));
  }
  deleteMany(
    ids: string[],
    force: boolean,
    context: Record<string, any> | null | undefined
  ): Promise<Record<string, any>[]> {
    // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
    return connect(this.host).then(network => network.deleteMany(ids, force, context));
  }
  deprecateMany(ids: string[], context: Record<string, any> | null | undefined): Promise<Record<string, any>[]> {
    return connect(this.host).then(network => network.deprecateMany(ids, context));
  }
  undeprecateMany(ids: string[], context: Record<string, any> | null | undefined): Promise<Record<string, any>[]> {
    return connect(this.host).then(network => network.undeprecateMany(ids, context));
  }

  static load(name: string, host: string): Remote {
    const primary = isPrimary(name);
    if (primary) name = cleanBang(name);

    return new Remote(name, host, primary);
  }
}