/**
 * Every caught error in the desktop app has to say what became of it.
 *
 * The app drives browsers on a machine nobody can look at, and the failures
 * that hurt most were the ones swallowed by a catch: a page load that failed
 * reported as one that worked, a sign-in that never happened reported as done.
 * So a catch must do one of three things, visibly:
 *
 *   - rethrow (throw anything),
 *   - record it: note(), fail() or logEvent(),
 *   - or say why it is normal, with a comment starting `expected:`.
 *
 * The comment is the escape hatch for the genuinely routine -- a string that is
 * not a URL, a file that is not there yet -- and it has to name the reason, so
 * a reader can disagree with it.
 */

const RECORDERS = new Set(['note', 'fail', 'logEvent']);

function explains(node, sourceCode) {
  const comments = sourceCode.getCommentsInside
    ? sourceCode.getCommentsInside(node)
    : sourceCode
        .getAllComments()
        .filter((c) => c.range[0] >= node.range[0] && c.range[1] <= node.range[1]);
  if (comments.some((c) => /^\s*expected:\s*\S/.test(c.value))) return true;

  let found = false;
  const visit = (n) => {
    if (found || !n || typeof n.type !== 'string') return;
    if (n.type === 'ThrowStatement') found = true;
    if (n.type === 'CallExpression') {
      const callee = n.callee;
      const name = callee.type === 'Identifier' ? callee.name : callee.property?.name;
      if (RECORDERS.has(name)) found = true;
    }
    for (const key of Object.keys(n)) {
      if (key === 'parent') continue;
      const child = n[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child.type === 'string') visit(child);
    }
  };
  visit(node);
  return found;
}

const MESSAGE =
  'Explain this catch: record it with note()/logEvent(), rethrow, or mark it ' +
  '`// expected: why this is normal`.';

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Require every caught error to be recorded, rethrown or explained.' },
    schema: [],
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    return {
      CatchClause(node) {
        if (!explains(node.body, sourceCode)) context.report({ node, message: MESSAGE });
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.property?.name !== 'catch') return;
        const handler = node.arguments[0];
        // A named handler is somebody else's decision, made where it is defined.
        if (!handler || !/FunctionExpression$/.test(handler.type)) return;
        if (!explains(handler.body, sourceCode)) context.report({ node, message: MESSAGE });
      },
    };
  },
};
