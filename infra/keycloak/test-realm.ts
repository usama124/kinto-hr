// Disposable test fixture retains its original narrow realm-name restriction.
import { loopbackRealm, type LoopbackRealmInput } from './loopback-realm';
export type KeycloakFixture = LoopbackRealmInput;
export function testRealm(input: KeycloakFixture) {
  if (!/^kinto_test_[a-f0-9]{32}$/.test(input.realm))
    throw new Error('Synthetic local realm required');
  return loopbackRealm(input);
}
