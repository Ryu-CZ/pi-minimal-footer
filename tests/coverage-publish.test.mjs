import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(new URL('../.github/workflows/coverage.yml', import.meta.url), 'utf8');
const scriptMarker = '          script: |\n';
assert.equal(workflow.split(scriptMarker).length, 2, 'expected one GitHub publication script');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const publish = new AsyncFunction('require', 'github', 'context', workflow.split(scriptMarker)[1]);

for (const scenario of ['new branch', 'existing branch', 'outdated run', 'permission denied']) {
  test(`coverage publication with github-script v7 client: ${scenario}`, async () => {
    const calls = [];
    const badge = '<svg>coverage</svg>';
    const context = { repo: { owner: 'owner', repo: 'repo' }, sha: 'source-sha' };
    const git = {
      async getRef(args) {
        calls.push(['getRef', args]);
        if (args.ref === 'heads/main') return { data: { object: { sha: scenario === 'outdated run' ? 'newer-sha' : context.sha } } };
        if (scenario === 'permission denied') throw Object.assign(new Error('Forbidden'), { status: 403 });
        if (scenario === 'new branch') throw Object.assign(new Error('Not found'), { status: 404 });
        return { data: { object: { sha: 'parent-sha' } } };
      },
      async createTree(args) { calls.push(['createTree', args]); return { data: { sha: 'tree-sha' } }; },
      async createCommit(args) { calls.push(['createCommit', args]); return { data: { sha: 'commit-sha' } }; },
      async createRef(args) { calls.push(['createRef', args]); },
      async updateRef(args) { calls.push(['updateRef', args]); },
    };
    const require = (name) => {
      assert.equal(name, 'node:fs/promises');
      return { readFile: async (path, encoding) => {
        assert.equal(path, 'coverage.svg');
        assert.equal(encoding, 'utf8');
        return badge;
      } };
    };
    // github-script v7 exposes REST endpoints under github.rest, not github.git.
    const run = () => publish(require, { rest: { git } }, context);
    if (scenario === 'permission denied') {
      await assert.rejects(run(), { message: 'Forbidden', status: 403 });
      assert.deepEqual(calls.map(([name]) => name), ['getRef', 'getRef']);
      return;
    }
    await run();
    if (scenario === 'outdated run') {
      assert.deepEqual(calls.map(([name]) => name), ['getRef']);
      return;
    }
    assert.deepEqual(calls.map(([name]) => name), ['getRef', 'getRef', 'createTree', 'createCommit', scenario === 'new branch' ? 'createRef' : 'updateRef']);
    assert.deepEqual(calls[2][1].tree, [{ path: 'badge.svg', mode: '100644', type: 'blob', content: badge }]);
    assert.equal(calls[3][1].tree, 'tree-sha');
    assert.deepEqual(calls[3][1].parents, scenario === 'new branch' ? [] : ['parent-sha']);
    assert.equal(calls[4][1].ref, scenario === 'new branch' ? 'refs/heads/coverage' : 'heads/coverage');
    assert.equal(calls[4][1].sha, 'commit-sha');
    assert.equal(calls[4][1].force, undefined, 'publication must not force-update the branch');
  });
}
