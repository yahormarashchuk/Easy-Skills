export function githubRepository(value: string): string | undefined {
  let path: string;
  if (/^git@github\.com:/i.test(value)) path = value.slice(value.indexOf(':') + 1);
  else {
    let url: URL;
    try {url = new URL(value);} catch {return undefined;}
    if (!['https:', 'ssh:'].includes(url.protocol) || url.hostname.toLowerCase() !== 'github.com' ||
      url.password || url.search || url.hash || (url.port && url.port !== (url.protocol === 'https:' ? '443' : '22')) ||
      (url.protocol === 'https:' && url.username) || (url.protocol === 'ssh:' && url.username !== 'git')) return undefined;
    path = url.pathname.slice(1);
  }
  const match = path.match(/^([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
  return match?.[1]?.toLowerCase();
}
