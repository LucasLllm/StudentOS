import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';
import rule from './explained-catch.js';

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { ecmaVersion: 'latest', sourceType: 'module' } });

tester.run('explained-catch', rule, {
  valid: [
    `try { a() } catch (e) { note('x', { error: e.message }) }`,
    `try { a() } catch (e) { throw e }`,
    `try { a() } catch (e) { if (x) { fail(e) } }`,
    `try { a() } catch (e) { logEvent('transport.offline', e.message) }`,
    `function f() {
       try { a() } catch {
         // expected: not a URL, so it belongs to no site
         return false;
       }
     }`,
    `try { a() } catch { /* expected: already detached */ }`,
    `try { a() } catch {
       /*
        * expected: a multi-line block comment, starred.
        */
     }`,
    `p.catch((e) => logEvent('x', e.message))`,
    `p.catch((e) => { note('close.failed', { error: e.message }) })`,
    `p.catch((e) => { throw new Failure('nav.failed', e.message) })`,
    `p.catch(onError)`,
  ],
  invalid: [
    { code: `try { a() } catch {}`, errors: 1 },
    { code: `try { a() } catch { /* gone */ }`, errors: 1 },
    { code: `function f() { try { a() } catch (e) { return null } }`, errors: 1 },
    { code: `p.catch(() => {})`, errors: 1 },
    { code: `p.catch(() => null)`, errors: 1 },
    { code: `p.catch(() => { // already gone\n })`, errors: 1 },
  ],
});
