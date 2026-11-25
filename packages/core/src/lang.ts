const EXT: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', kts: 'Kotlin', cs: 'C#', php: 'PHP', rb: 'Ruby', swift: 'Swift',
  c: 'C', h: 'C', cpp: 'C++', cc: 'C++', hpp: 'C++', scala: 'Scala', dart: 'Dart', lua: 'Lua', ex: 'Elixir', exs: 'Elixir',
  css: 'CSS', scss: 'CSS', sass: 'CSS', less: 'CSS', html: 'HTML', htm: 'HTML', vue: 'Vue', svelte: 'Svelte',
  sql: 'SQL', sh: 'Shell', bash: 'Shell', zsh: 'Shell', ps1: 'PowerShell',
  json: 'JSON', yml: 'YAML', yaml: 'YAML', toml: 'TOML', md: 'Markdown', mdx: 'Markdown', tf: 'Terraform', proto: 'Protobuf', graphql: 'GraphQL'
};
/** Languages with logic in them, as opposed to data, markup, docs or styles. */
const LOGIC = new Set(['TypeScript', 'JavaScript', 'Python', 'Go', 'Rust', 'Java', 'Kotlin', 'C#', 'PHP', 'Ruby', 'Swift', 'C', 'C++', 'Scala', 'Dart', 'Lua', 'Elixir', 'Vue', 'Svelte', 'SQL', 'Shell', 'PowerShell']);

export function languageOf(file: string): string | null {
  const base = file.split('/').pop() || '';
  if (/^Dockerfile(\..+)?$/i.test(base)) return 'Dockerfile';
  if (/^Makefile$/i.test(base)) return 'Makefile';
  const m = /\.([A-Za-z0-9]+)$/.exec(base);
  return m ? EXT[m[1].toLowerCase()] ?? null : null;
}

export const isTestPath = (p: string): boolean =>
  /(^|\/)(__tests__|tests?|specs?|e2e|cypress|__mocks__|fixtures?)\//i.test(p) ||
  /\.(test|spec)\.[A-Za-z0-9]+$/i.test(p) ||
  /(^|\/)test_[^/]*\.py$/.test(p) ||
  /_test\.(go|py|rb|rs|exs?)$/.test(p) ||
  /(Test|Tests|IT|Spec)\.(java|kt|cs|scala|swift)$/.test(p);

export const isDocPath = (p: string): boolean => /\.(md|mdx|txt|rst|adoc)$/i.test(p) || /(^|\/)(docs?|documentation)\//i.test(p) || /(^|\/)(LICENSE|CHANGELOG|NOTICE|CODEOWNERS)/i.test(p);
export const isLockfile = (p: string): boolean => /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|go\.sum|Gemfile\.lock|composer\.lock|Pipfile\.lock)$/.test(p);
export const isGenerated = (p: string): boolean => /(^|\/)(dist|build|out|node_modules|vendor|\.next|\.nuxt|coverage|target|__pycache__)\//.test(p) || /\.(min\.(js|css)|map|snap|lock)$/.test(p) || isLockfile(p);
/** A folder of demos, previews, fixtures or docs: code there isn't the product. Stricter than isExamplePath, which matches words anywhere. */
export const isDemoPath = (p: string): boolean => /(^|\/)(docs?|examples?|samples?|demos?|preview|previews|prototypes?|fixtures?|mocks?|stories|storybook)\//i.test(p);
export const isExamplePath = (p: string): boolean => /(example|sample|template|dummy|mock|fake|fixture|demo)/i.test(p) || /\.(example|sample|template|dist)$/i.test(p);

/** Production logic: not a test, not generated, not docs, written in a language with logic in it. */
export function isSourcePath(p: string): boolean {
  const l = languageOf(p);
  return !!l && LOGIC.has(l) && !isTestPath(p) && !isGenerated(p) && !isDocPath(p);
}

/** Paths where a mistake costs more: who you are, money, secrets, schema, how it ships. */
export const SENSITIVE = /(auth|login|logout|session|token|secret|crypto|password|passwd|payment|checkout|billing|invoice|admin|permission|acl|rbac|middleware|security|sanitiz|escape|\.env|migration|schema|deploy|infra|workflow|dockerfile|terraform)/i;
