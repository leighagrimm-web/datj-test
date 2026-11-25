// Pushes apps-script/admin/ to the TEST or LIVE Apps Script project and moves both web app deployments (signin,
// public) to the new version, so their URLs never change. Usage: node tools/deploy-admin.js test|live ["what changed"]
//
// A deployment takes its "Execute as", "Who has access" and permissions from the manifest of the version it runs, and
// the two differ: signin runs as whoever opens it ("Anyone with a Google account") with only the email-address
// permission, so the owner and her helpers can sign in; public runs as the owner for "Anyone" (the admin posts here;
// every action checks the sign-in pass). So this pushes once per deployment with that deployment's manifest.
// The first run for a target creates the deployments and saves their IDs in apps-script/admin/deployments.json
// (IDs aren't secrets; commit them).
//
// Sign-ins: `clasp login --user datj-test` (and later `--user datj-live`), done once by Leigha.
// Script Properties and the first permission prompt (run setup() in the editor) stay by hand.
// The repo is the master copy: a push overwrites the code in the editor. Ask before every push; LIVE only on a go.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CLASP = '@google/clasp@3.4.1';
const SRC = path.join(__dirname, '..', 'apps-script', 'admin');
const IDS = path.join(SRC, 'deployments.json');
const ACCESS = {
  signin: { executeAs: 'USER_ACCESSING', access: 'ANYONE' },
  public: { executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' }
};
// signin only reads who's signing in; it never touches the Sheet or GitHub
const SCOPES = { signin: ['https://www.googleapis.com/auth/userinfo.email'] };

const env = process.argv[2];
const note = process.argv[3] || '';
const all = JSON.parse(fs.readFileSync(IDS, 'utf8'));
const t = all[env];
if (!t) { console.error('Usage: node tools/deploy-admin.js test|live ["what changed"]'); process.exit(1); }
if (!t.scriptId) { console.error('No scriptId for ' + env + ' in apps-script/admin/deployments.json yet.'); process.exit(1); }

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'datj-deploy-'));
fs.readdirSync(SRC).filter((f) => /\.(gs|html)$/.test(f)).forEach((f) => fs.copyFileSync(path.join(SRC, f), path.join(stage, f)));
// The shared calendar code (also used by the website build) goes in as FeedCore.gs; Feed.gs serves the dancer feeds
fs.copyFileSync(path.join(SRC, '..', 'calendar-feed.gs'), path.join(stage, 'FeedCore.gs'));
fs.writeFileSync(path.join(stage, '.clasp.json'), JSON.stringify({ scriptId: t.scriptId, rootDir: '.' }));
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'appsscript.json'), 'utf8'));

function clasp(args) {
  console.log('> clasp ' + args.join(' '));
  return execFileSync('npx', ['--yes', CLASP].concat(args, ['--user', t.user]), { cwd: stage, shell: true, encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
}

function deploy(which) {
  const m = Object.assign({}, manifest, { webapp: ACCESS[which] });
  if (SCOPES[which]) m.oauthScopes = SCOPES[which];
  fs.writeFileSync(path.join(stage, 'appsscript.json'), JSON.stringify(m, null, 2));
  process.stdout.write(clasp(['push', '--force']));
  const desc = '"' + (which + ' ' + new Date().toISOString().slice(0, 10) + (note ? ': ' + note : '')).replace(/"/g, "'") + '"';
  const id = t.deployments[which];
  const out = clasp(id ? ['deploy', '-i', id, '-d', desc] : ['deploy', '-d', desc]);
  process.stdout.write(out);
  if (!id) {
    const m = /(AKfy[\w-]+)/.exec(out);
    if (!m) throw new Error('Couldn’t read the new ' + which + ' deployment ID from clasp’s output.');
    t.deployments[which] = m[1];
    fs.writeFileSync(IDS, JSON.stringify(all, null, 2) + '\n');
    console.log('Saved the new ' + which + ' deployment: https://script.google.com/macros/s/' + m[1] + '/exec');
  }
}

try {
  deploy('public');
  deploy('signin');
  console.log('\nDone: ' + env.toUpperCase() + ' signin and public are on the new version.');
  Object.keys(t.deployments).forEach((k) => console.log('  ' + k + ': https://script.google.com/macros/s/' + t.deployments[k] + '/exec'));
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
