import { KernelManager } from "./packages/code-runtime-ipython/src/kernel-manager.js";

const km = new KernelManager("test", async (method, params) => {
  if (method === "rlm.run") {
    return {
      rlm_child_id: "child-1",
      name: params.name ?? "scan",
      session_dir: "/tmp/rlm",
      model: "test",
    };
  }
  throw new Error(`unexpected host ${method}`);
});

const fail = (msg) => {
  console.error("FAIL", msg);
  process.exitCode = 1;
};

await km.start();

const a = await km.execute("n = 41\nprint('set n')\nn");
if (a.error) fail(a.error.message);
if (a.value !== 41) fail(`expected 41 got ${JSON.stringify(a.value)}`);
if (!a.logs.includes("set n")) fail(`logs ${a.logs}`);

const b = await km.execute("n + 1");
if (b.value !== 42) fail(`persist failed, got ${JSON.stringify(b.value)}`);

const snap = JSON.parse(Buffer.from(await km.snapshotNamespace()).toString());
if (!String(snap.n).startsWith("int:")) fail(`snapshot ${JSON.stringify(snap)}`);

const c = await km.execute("unknown_name");
if (!c.error) fail("expected NameError");

const d = await km.execute("context = 'haystack-needle-haystack'\ncontext.find('needle')");
if (d.value !== 9) fail(`find got ${d.value}`);


const km2 = new KernelManager("rlm", async (method, params) => {
  if (method === "rlm.run") {
    return {
      rlm_child_id: "child-1",
      name: params.name ?? "scan",
      session_dir: "/tmp/rlm",
      model: "test",
    };
  }
  throw new Error(`unexpected host ${method}`);
});
await km2.start();
const r = await km2.execute('h = await rlm("extract token", name="scan-0")\nh.name');
if (r.error) fail(`rlm cell: ${r.error.message}`);
if (r.value !== "scan-0") fail(`rlm handle name ${JSON.stringify(r.value)} ${JSON.stringify(r)}`);
await km2.shutdown();

const km3 = new KernelManager("bash", async (method, params) => {
  if (method === "tools.dispatch" && params.name === "bash") {
    const cmd = params.args?.command ?? "";
    if (cmd.trim() === "ls") return "haystack.txt\nnotes.md";
    throw new Error(`unexpected bash ${cmd}`);
  }
  throw new Error(`unexpected host ${method}`);
});
await km3.start();
const bsh = await km3.execute("%%bash\nls");
if (bsh.error) fail(`bash: ${bsh.error.message}`);
if (!String(bsh.value).includes("haystack.txt")) fail(`bash value ${JSON.stringify(bsh)}`);
await km3.shutdown();

const km4 = new KernelManager("path", async (method, params) => {
  if (method === "tools.dispatch" && params.name === "read") {
    return {
      path: params.args?.file_path,
      offset: 1,
      lines: [{ number: 1, text: "xxneedleyy" }],
      totalLines: 1,
    };
  }
  if (method === "rlm.load_haystack") return "haystack-needle-haystack";
  if (method === "rlm.save_skill") return true;
  if (method === "rlm.list_skills") return ["scan"];
  throw new Error(`unexpected host ${method} ${JSON.stringify(params)}`);
});
await km4.start();
const hay = await km4.execute("load_haystack()");
if (hay.error) fail(`haystack: ${hay.error.message}`);
if (hay.value !== "haystack-needle-haystack") fail(`hay ${JSON.stringify(hay)}`);
const pth = await km4.execute('p = Path("haystack.txt")\np.read_text().find("needle")');
if (pth.error) fail(`path: ${pth.error.message}`);
if (pth.value !== 2) fail(`path find ${JSON.stringify(pth)}`);
await km4.shutdown();

const hayStore = { text: "" };
const kmHaySet = new KernelManager("hayset", async (method, params) => {
  if (method === "rlm.set_haystack") {
    hayStore.text = String(params.text ?? "");
    return true;
  }
  if (method === "rlm.load_haystack") return hayStore.text;
  if (method === "tools.dispatch" && params.name === "bash") return "bash-ok";
  throw new Error(`unexpected host ${method}`);
});
await kmHaySet.start();
const sameCell = await kmHaySet.execute(
  'set_haystack("needle-at-offset-XYZ")\ncontext.find("XYZ")',
);
if (sameCell.error) fail(`same-cell haystack: ${sameCell.error.message}`);
if (sameCell.value !== 17) fail(`same-cell context stale ${JSON.stringify(sameCell)}`);
const mixed = await kmHaySet.execute('x = 1\nprint("py", x)\n%%bash\necho bash-ok');
if (mixed.error) fail(`mixed bash: ${mixed.error.message}`);
if (!(mixed.logs || []).join("\n").includes("py 1")) fail(`mixed py logs ${JSON.stringify(mixed.logs)}`);
await kmHaySet.shutdown();

const pwshCalls = [];
const kmWin = new KernelManager("win-shell", async (method, params) => {
  if (method !== "tools.dispatch") throw new Error(`unexpected ${method}`);
  pwshCalls.push(params);
  if (params.name === "bash") throw new Error("no bash binding");
  if (params.name === "pwsh") {
    if (!params.args || typeof params.args !== "object") fail(`pwsh args not object ${JSON.stringify(params.args)}`);
    if (!params.args.description) fail(`pwsh missing description ${JSON.stringify(params.args)}`);
    if (!params.args.command) fail(`pwsh missing command ${JSON.stringify(params.args)}`);
    return `pwsh:${String(params.args.command).trim()}`;
  }
  throw new Error(`unexpected tool ${params.name}`);
});
await kmWin.start();
const crlf = await kmWin.execute("print('py')\r\n%%bash\r\necho bash-ok\r\n");
if (crlf.error) fail(`crlf bash: ${crlf.error.message}`);
if (!(crlf.logs || []).join("\n").includes("py")) fail(`crlf py ${JSON.stringify(crlf.logs)}`);
const alias = await kmWin.execute('await tools.bash("echo hi")');
if (alias.error) fail(`tools.bash alias: ${alias.error.message}`);
if (alias.value !== "pwsh:echo hi") fail(`alias value ${JSON.stringify(alias)}`);
const magicPwsh = await kmWin.execute("%%pwsh\nGet-Date");
if (magicPwsh.error) fail(`%%pwsh: ${magicPwsh.error.message}`);
await kmWin.shutdown();

const skillStore = new Map();
const kmSkill = new KernelManager("skill", async (method, params) => {
  if (method === "rlm.save_skill") {
    skillStore.set(String(params.name), String(params.code ?? ""));
    return String(params.name);
  }
  if (method === "rlm.load_skill") {
    const code = skillStore.get(String(params.name));
    if (code === undefined) throw new Error(`missing ${params.name}`);
    return code;
  }
  if (method === "rlm.list_skills") return [...skillStore.keys()];
  throw new Error(`unexpected host ${method}`);
});
await kmSkill.start();
const saved = await kmSkill.execute(
  "save_skill('double', 'def double(x):\\n    return x * 2\\n')\nload_skill('double')\ndouble(21)",
);
if (saved.error) fail(`skill: ${saved.error.message}`);
if (saved.value !== 42) fail(`skill double ${JSON.stringify(saved)}`);
await kmSkill.shutdown();

const km5 = new KernelManager("inspect", async (method) => {
  if (method === "rlm.load_haystack") return "abcSEAM";
  throw new Error(`unexpected host ${method}`);
});
await km5.start();
const loaded = await km5.execute("n = 41\ncontext = load_haystack()\nn");
if (loaded.error) fail(`load: ${loaded.error.message}`);
const dumped = await km5.inspectNamespace();
if (dumped.n !== 41) fail(`inspect n ${JSON.stringify(dumped)}`);
if (dumped.context !== "abcSEAM") fail(`inspect context ${JSON.stringify(dumped)}`);
await km5.shutdown();

const km6 = new KernelManager("inject", async () => {
  throw new Error("host should not run");
});
await km6.start();
await km6.injectNamespace(dumped);
const back = await km6.execute("n + 1");
if (back.error) fail(`inject: ${back.error.message}`);
if (back.value !== 42) fail(`inject persist ${JSON.stringify(back)}`);
const ret = await km6.execute("return n");
if (ret.error) fail(`return rewrite: ${ret.error.message}`);
if (ret.value !== 41) fail(`return value ${JSON.stringify(ret)}`);
await km6.shutdown();

if (process.exitCode) process.exit(process.exitCode);
console.log("ok persist + snapshot + error + slice + rlm() + %%bash + Path + haystack + inspect/inject");
process.exit(0);

