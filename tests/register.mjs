// Run tests with: node --import ./tests/register.mjs --test
import { registerHooks } from 'node:module';

const fakeSdkUrl = new URL('./fake-sdk.mjs', import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'sdk' || specifier === 'sdk/db') {
      return { url: fakeSdkUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
