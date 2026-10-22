import { randomUUID } from 'node:crypto';
import { Gh } from '../src/github/index.js';
import { Store } from '../src/persistence/store.js';
import { settings, mailTransport } from '../src/notifications/index.js';

const args = process.argv.slice(2);
if (process.env.EASY_SKILLS_ALLOW_EXTERNAL !== '1' || !args.includes('--allow-external'))
  throw new Error('External checks are disabled. Obtain explicit permission, set EASY_SKILLS_ALLOW_EXTERNAL=1 and pass --allow-external. This may create/close a GitHub Issue or send real email.');
const at = args.indexOf('--github'), smtp = args.includes('--smtp');
if (at < 0 && !smtp) throw new Error('Select --github OWNER/DISPOSABLE_REPO or --smtp');
if (at >= 0) {
  const repository = args[at + 1];
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Provide an explicitly authorized disposable GitHub repository');
  const github = new Gh(repository, process.cwd());
  const number = await github.issue('external-smoke:' + randomUUID(), 'Easy Skills opt-in connectivity check', 'Explicitly authorized integration check. This Issue will be closed after creation.');
  await github.setIssue(number, false, 'Opt-in Issue create/close check completed. This does not validate PRs, CI, merge gates or a real-client feature.');
  console.log(JSON.stringify({github: {repository, issue: number, createdAndClosed: true}}));
}
if (smtp) {
  const store = new Store();
  try {
    const config = settings(store).smtp;
    if (!config) throw new Error('Configure SMTP before the opt-in test');
    await mailTransport(config).sendMail({from: config.from, to: config.to, subject: '[Easy Skills] Explicitly authorized SMTP check', text: 'Opt-in connectivity test. SMTP acceptance is not proof of inbox delivery.'});
    console.log(JSON.stringify({smtpAccepted: true}));
  } finally {store.close();}
}
