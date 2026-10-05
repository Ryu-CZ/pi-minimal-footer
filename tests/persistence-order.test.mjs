import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Set the agent directory before importing Pi: config.js captures it at module load.
const root = resolve(import.meta.dirname, '..');
const piRoot = dirname(fileURLToPath(await import.meta.resolve('@earendil-works/pi-coding-agent')));
const isolated = await mkdtemp(join(tmpdir(), 'min-footer-persistence-'));
const agentDir = join(isolated, 'agent');
process.env.HOME = join(isolated, 'other-home');
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = '1';

const { loadExtensions } = await import(join(piRoot, 'core/extensions/loader.js'));
const { SessionManager } = await import(join(piRoot, 'core/session-manager.js'));
const { ModelRuntime } = await import(join(piRoot, 'core/model-runtime.js'));
const { createAgentSession } = await import(join(piRoot, 'core/sdk.js'));
const { getThemeByName } = await import(join(piRoot, 'modes/interactive/theme/theme.js'));

const theme = getThemeByName('dark');
test.after(async () => { await rm(isolated, { recursive: true, force: true }); });

test('real AgentSession persists after message_end and footer refreshes from persisted turn_end usage', async () => {
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ minFooter: { enabled: true, showPath: false, showGitBranch: false, showSkills: false } }));
  const loaded = await loadExtensions([join(root, 'extensions')], root);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  assert.ok(extension.handlers.has('turn_end'));
  assert.equal(extension.handlers.has('message_end'), false);

  let session;
  const seen = [];
  extension.handlers.set('message_end', [(_event, ctx) => {
    seen.push({ messages: ctx.sessionManager.buildSessionProjection().messages.length, usage: ctx.getContextUsage() });
  }]);
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const model = modelRuntime.getAllModels().find((m) => m.contextWindow === 128000 && m.provider && m.id);
  assert.ok(model, 'offline builtin model required');
  const sm = SessionManager.inMemory(join(isolated, 'project'));
  const resourceLoader = {
    getExtensions: () => loaded,
    getSkills: () => ({ skills: [] }),
    getPrompts: () => ({ prompts: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    getAgentsFiles: () => ({ agentsFiles: [] }),
  };
  ({ session } = await createAgentSession({
    cwd: sm.getCwd(), agentDir, modelRuntime, model, sessionManager: sm, resourceLoader, tools: [], noTools: 'all',
  }));
  let component;
  const ui = {
    setFooter(factory) {
      component?.dispose?.();
      component = factory?.({ requestRender() {} }, theme, {
        getExtensionStatuses: () => new Map(),
        getGitBranch: () => null,
        onBranchChange: () => () => {},
      });
    },
    notify() {},
  };
  await session.bindExtensions({ uiContext: ui, mode: 'tui' });
  assert.ok(component, 'real runner installed footer');
  const before = session.getContextUsage();
  const assistant = {
    role: 'assistant', content: [{ type: 'text', text: 'offline answer' }],
    api: model.api, provider: model.provider, model: model.id,
    usage: { input: 123, output: 17, cacheRead: 0, cacheWrite: 0, totalTokens: 140,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop', timestamp: Date.now(),
  };
  const toolResult = {
    role: 'toolResult', toolCallId: 'x', toolName: 'offline-tool',
    content: [{ type: 'text', text: 'offline result' }], isError: false, timestamp: Date.now(),
  };
  await session._handleAgentEvent({ type: 'message_end', message: assistant });
  assert.equal(seen[0].messages, 0, 'message_end sees pre-persistence projection');
  assert.deepEqual(seen[0].usage, before, 'message_end sees pre-persistence usage');
  await session._handleAgentEvent({ type: 'message_end', message: toolResult });
  assert.equal(seen[1].messages, 1, 'tool message_end also precedes persistence');
  const projected = sm.buildSessionProjection().messages;
  assert.equal(projected.length, 2);
  assert.equal(projected[0].role, 'assistant');
  assert.equal(projected[1].role, 'toolResult');
  const after = session.getContextUsage();
  assert.notDeepEqual(after, before, 'real projection-derived token usage changed after persistence');
  await session._handleAgentEvent({ type: 'turn_end', message: assistant, toolResults: [toolResult] });
  assert.equal(sm.buildSessionProjection().messages.length, 2);
  const footer = component.render(120)[0];
  assert.equal(session.getContextUsage()?.tokens, after.tokens, 'turn_end did not change projected usage');
  assert.equal(after.contextWindow, 128000);
  assert.match(footer, new RegExp(`${after.tokens}/128k`),
    `footer displays real post-persistence context: before=${JSON.stringify(before)}, after=${JSON.stringify(after)}`);

  // A real compaction entry makes old assistant usage unknown until another response.
  sm.appendCompaction('offline summary', undefined, after.tokens, undefined, false);
  const compacted = session.getContextUsage();
  assert.equal(compacted.tokens, null);
  await session._extensionRunner.emit({ type: 'session_compact', compactionEntry: sm.getBranch().at(-1), fromExtension: false, reason: 'manual', willRetry: false });
  assert.match(component.render(120)[0], /\?\/128k/);
  const nextAssistant = { ...assistant, usage: { ...assistant.usage, input: 222, output: 33, totalTokens: 255 }, timestamp: Date.now() + 1 };
  await session._handleAgentEvent({ type: 'message_end', message: nextAssistant });
  await session._handleAgentEvent({ type: 'turn_end', message: nextAssistant, toolResults: [] });
  const recovered = session.getContextUsage();
  assert.ok(recovered.tokens > 0, 'post-compaction assistant restores known usage');
  assert.match(component.render(120)[0], new RegExp(`${recovered.tokens}/128k`));

  await session._extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  component.dispose();
  session.dispose();
});
