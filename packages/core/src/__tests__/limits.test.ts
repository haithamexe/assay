import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { makeRepo, tempHome } from './fixtures.js';

/* Three of the known limits, closed (D54): more test runners found, a renamed file still looked for, and rules for Java, Kotlin, C# and Rust. */
tempHome();
const core = await import('../index.js');

const dir = (files: Record<string, string>): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'assay-runner-'));
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), text); }
  return d;
};

test('the test runners Assay finds by itself: .NET, Maven, Gradle, Deno, RSpec and a make test target, in a fixed order', () => {
  const text = (files: Record<string, string>): string | undefined => core.detectCommand(dir(files))?.text;
  assert.equal(text({ 'src/App.csproj': '<Project/>' }), undefined, 'a project in a subfolder only is not at the root');
  assert.equal(text({ 'App.sln': '' }), 'dotnet test');
  assert.equal(text({ 'App.csproj': '<Project/>' }), 'dotnet test');
  assert.equal(text({ 'pom.xml': '<project/>' }), 'mvn -B -q test');
  const gradle = text({ 'build.gradle.kts': '', gradlew: '', 'gradlew.bat': '' });
  assert.match(String(gradle), /^(?:\.\/gradlew|gradlew\.bat) test --console=plain$/, 'the wrapper when the project has one');
  assert.equal(text({ 'settings.gradle': '' }), 'gradle test --console=plain');
  assert.equal(text({ 'deno.json': '{}' }), 'deno test');
  assert.equal(text({ Gemfile: "source 'https://rubygems.org'\n", 'spec/a_spec.rb': '' }), 'bundle exec rspec');
  assert.equal(text({ Gemfile: "source 'https://rubygems.org'\n" }), undefined, 'a Gemfile with no spec folder has no tests to run');
  assert.equal(text({ Makefile: 'build:\n\tcc main.c\n\ntest:\n\t./run-tests\n' }), 'make test');
  assert.equal(text({ Makefile: 'build:\n\tcc main.c\n\nretest:\n\techo no\n' }), undefined, 'a target that merely ends in test is not "test"');
  // what was found before still wins, and the person's own command beats everything
  assert.equal(text({ 'package.json': '{"scripts":{"test":"node --test"}}', 'pom.xml': '<project/>' }), 'npm test');
  assert.equal(text({ 'Cargo.toml': '[package]\nname="a"\n', 'pom.xml': '<project/>' }), 'cargo test');
  assert.equal(core.detectCommand(dir({ 'pom.xml': '<project/>' }), 'make check')?.text, 'make check');
  // the ones that are scripts on Windows go through the shell; real programs don't
  assert.equal(core.detectCommand(dir({ 'pom.xml': '<project/>' }))?.shell, true);
  assert.equal(core.detectCommand(dir({ 'App.sln': '' }))?.shell, false);
});

test('a file that was only renamed is still looked for, so a rename alone does not make a finding look fixed', () => {
  const repo = makeRepo();
  repo.commit({ 'README.md': '# x\n' }, 'Base');
  const body = 'export function show(el, text) {\n  el.innerHTML = text;\n  return el;\n}\n';
  repo.commit({ 'src/a.js': body }, 'Add the view');
  repo.commit({ 'src/a.js': null, 'src/b.js': body }, 'Rename the view');
  const c = core.openCase({ repo: repo.dir, range: 'HEAD~2..HEAD' });
  const f = c.findings.find(x => x.evidence.some(e => e.source === 'rule:html-injection'))!;
  assert.equal(f.file, 'src/a.js', 'the finding is in the file as the commit that added it called it');
  assert.equal(f.present, true, 'and it is still there, under another name');
  assert.notEqual(core.findingState(c, f), 'fixed', 'a rename is not a fix');

  // renamed again: it is followed to the last name
  repo.commit({ 'src/b.js': null, 'src/views/b.js': body }, 'Move it into a folder');
  const c2 = core.openCase({ repo: repo.dir, range: 'HEAD~3..HEAD' });
  assert.equal(c2.findings.find(x => x.id === f.id)!.present, true);

  // and the line fixed after the rename is fixed
  repo.commit({ 'src/views/b.js': body.replace('el.innerHTML = text;', 'el.textContent = text;') }, 'Show it as text');
  const c3 = core.openCase({ repo: repo.dir, range: 'HEAD~4..HEAD' });
  assert.equal(c3.findings.find(x => x.id === f.id)!.present, false, 'the fix is found in the renamed file');
});

const review = (files: Record<string, string>): ReturnType<typeof core.openCase> => {
  const repo = makeRepo();
  repo.commit({ 'README.md': '# x\n' }, 'Base');
  repo.commit(files, 'Change');
  return core.openCase({ repo: repo.dir, range: 'HEAD' });
};
const flagged = (c: ReturnType<typeof core.openCase>, file: string, rule: string): boolean => c.findings.some(f => f.file === file && f.evidence.some(e => e.source === `rule:${rule}`));

test('the shell, deserialisation and certificate rules know Java, Kotlin, C# and Rust, and leave the look-alikes alone', () => {
  const c = review({
    'src/Run.java': 'class Run {\n  void go(String cmd) throws Exception {\n    Runtime.getRuntime().exec(cmd);\n  }\n}\n',
    'src/Cores.java': 'class Cores {\n  int n() {\n    return Runtime.getRuntime().availableProcessors();\n  }\n}\n',
    'src/Run.kt': 'fun go(cmd: String) {\n    ProcessBuilder("sh", "-c", cmd).start()\n}\n',
    'src/Run.cs': 'class Run {\n  void Go(string cmd) {\n    System.Diagnostics.Process.Start(cmd);\n  }\n}\n',
    'src/Load.cs': 'class Load {\n  object Go(System.IO.Stream s) {\n    return new BinaryFormatter().Deserialize(s);\n  }\n}\n',
    'src/Json.cs': 'class Json {\n  T Go<T>(string s) {\n    return System.Text.Json.JsonSerializer.Deserialize<T>(s);\n  }\n}\n',
    'src/Tls.cs': 'class Tls {\n  void Go(HttpClientHandler h) {\n    h.ServerCertificateCustomValidationCallback = (m, c, ch, e) => true;\n  }\n}\n',
    'src/Tls2.cs': 'class Tls2 {\n  void Go(HttpClientHandler h) {\n    h.ServerCertificateCustomValidationCallback = (m, c, ch, e) => e == SslPolicyErrors.None;\n  }\n}\n',
    'src/run.rs': 'fn go() {\n    std::process::Command::new("sh").arg("-c").status().unwrap();\n}\n',
    'src/git.rs': 'fn go() {\n    std::process::Command::new("git").arg("status").status().unwrap();\n}\n',
    'src/net.rs': 'fn go() {\n    let c = reqwest::Client::builder().danger_accept_invalid_certs(true).build();\n}\n',
    'src/net2.rs': 'fn go() {\n    let c = reqwest::Client::builder().danger_accept_invalid_certs(false).build();\n}\n'
  });
  assert.equal(flagged(c, 'src/Run.java', 'os-command-other'), true, 'Java runs a command');
  assert.equal(flagged(c, 'src/Cores.java', 'os-command-other'), false, 'Runtime.getRuntime() alone is not a command');
  assert.equal(flagged(c, 'src/Run.kt', 'os-command-other'), true, 'Kotlin, without new');
  assert.equal(flagged(c, 'src/Run.cs', 'os-command-other'), true);
  assert.equal(flagged(c, 'src/Load.cs', 'unsafe-deserialize'), true, 'BinaryFormatter');
  assert.equal(flagged(c, 'src/Json.cs', 'unsafe-deserialize'), false, 'a typed JSON deserialiser is not');
  assert.equal(flagged(c, 'src/Tls.cs', 'tls-off'), true);
  assert.equal(flagged(c, 'src/Tls2.cs', 'tls-off'), false, 'a callback that checks is not');
  assert.equal(flagged(c, 'src/run.rs', 'os-command-other'), true);
  assert.equal(flagged(c, 'src/git.rs', 'os-command-other'), false, 'running git directly is not running a shell');
  assert.equal(flagged(c, 'src/net.rs', 'tls-off'), true);
  assert.equal(flagged(c, 'src/net2.rs', 'tls-off'), false);
});

test('the same rules do not fire in a test file', () => {
  const c = review({ 'src/RunTest.java': 'class RunTest {\n  void go(String cmd) throws Exception {\n    Runtime.getRuntime().exec(cmd);\n  }\n}\n' });
  assert.equal(flagged(c, 'src/RunTest.java', 'os-command-other'), false);
});
