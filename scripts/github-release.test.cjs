const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { assertDraftAllowed, createInstallerRelease, publishRelease } = require('./github-release.cjs');
const context = { repo: { owner: 'test', repo: 'test' }, sha: 'test-commit' };
function fake(release, assets = []) {
  const calls = [];
  const repos = {
    // GitHub's tag endpoint only returns published releases.
    async getReleaseByTag() { if (!release || release.draft) throw Object.assign(new Error('not found'), {status:404}); return {data:release}; },
    async listReleases() {},
    async listReleaseAssets() {},
    async createRelease(input) {calls.push(['create', input]); release = {id:1, html_url:'https://example.test/release', ...input}; return {data:release};},
    async uploadReleaseAsset(input) {calls.push(['upload', input]); assets.push({name:input.name});},
    async deleteReleaseAsset(input) {calls.push(['delete',input]);},
    async updateRelease(input) {calls.push(['publish',input]); release = {...release,...input}; return {data:release};},
  };
  const summary = { addHeading(){return this;},addLink(){return this;},addRaw(){return this;},async write(){} };
  return { github: {rest:{repos}, async paginate(endpoint){
    return endpoint === repos.listReleases ? (release ? [{tag_name:'v0.5.0',...release}] : []) : assets;
  }}, calls, core:{summary} };
}
test('published releases cannot be overwritten', async () => {
  await assert.rejects(assertDraftAllowed({...fake({id:1,draft:false}),context,tag:'v0.5.0'}), /already published/);
});
test('missing release is allowed; authorization failures propagate', async () => {
  assert.equal(await assertDraftAllowed({...fake(null),context,tag:'v0.5.0'}), null);
  const api = fake(null); api.github.rest.repos.getReleaseByTag = async()=>{throw Object.assign(new Error('denied'),{status:403});};
  await assert.rejects(assertDraftAllowed({...api,context,tag:'v0.5.0'}),/denied/);
});

test('draft lookup falls back to the paginated release listing after tag lookup returns 404', async () => {
  const release = {id:9,tag_name:'v0.5.0',draft:true,body:'signed release'};
  const api = fake(release);
  assert.equal((await assertDraftAllowed({...api,context,tag:'v0.5.0',kind:'signed'})).id,9);
  assert.equal(await assertDraftAllowed({...api,context,tag:'v0.6.0',kind:'signed'}),null);
});

test('draft listing authorization errors are not treated as a missing release', async () => {
  const api = fake(null);
  api.github.paginate = async () => {throw Object.assign(new Error('listing denied'),{status:403});};
  await assert.rejects(assertDraftAllowed({...api,context,tag:'v0.5.0',kind:'signed'}),/listing denied/);
});
test('signed and unsigned drafts cannot be mixed', async () => {
  await assert.rejects(assertDraftAllowed({...fake({draft:true,body:'signed release'}),context,tag:'v0.5.0',kind:'unsigned'}), /different kind/);
  await assert.rejects(assertDraftAllowed({...fake({draft:true,body:'Unsigned test installers. Updater is disabled.'}),context,tag:'v0.5.0',kind:'signed'}), /different kind/);
});
async function installerDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mfa-release-test-'));
  t.after(async () => { for (const name of ['windows.exe','mac-arm.dmg','mac-x64.dmg','fourth.exe']) await fs.unlink(path.join(directory,name)).catch(() => {}); await fs.rmdir(directory); });
  for (const name of ['windows.exe','mac-arm.dmg','mac-x64.dmg']) await fs.writeFile(path.join(directory,name),'fake-installer');
  return directory;
}

test('uploads every installer before publishing an unsigned release without changing OTA latest', async (t) => {
  const directory = await installerDirectory(t);
  const api = fake(null); await createInstallerRelease({...api,context,tag:'v0.5.0',directory});
  assert.equal(api.calls.filter(([name])=>name==='upload').length,3);
  const [, input] = api.calls.find(([name])=>name==='create');
  assert.equal(input.draft,true); assert.equal(input.prerelease,false); assert.equal(input.target_commitish,context.sha);
  assert.deepEqual(api.calls.map(([name])=>name), ['create','upload','upload','upload','publish']);
  assert.equal(api.calls.at(-1)[1].draft,false);
  assert.equal(api.calls.at(-1)[1].prerelease,false);
  assert.equal(api.calls.at(-1)[1].make_latest,'false');
  await fs.writeFile(path.join(directory,'fourth.exe'),'bad');
  await assert.rejects(createInstallerRelease({...fake(null),context,tag:'v0.5.0',directory}),/three distinct/);
});

test('upload failures leave the release unpublished', async (t) => {
  const directory = await installerDirectory(t);
  const api = fake(null);
  api.github.rest.repos.uploadReleaseAsset = async () => {throw new Error('upload failed');};
  await assert.rejects(createInstallerRelease({...api,context,tag:'v0.5.0',directory}), /upload failed/);
  assert.equal(api.calls.some(([name])=>name==='publish'),false);
});

test('signed release becomes latest only when all installers and updater manifest exist', async () => {
  const assets = ['windows.exe','mac-arm.dmg','mac-x64.dmg'].map(name=>({name}));
  const api = fake({id:1,draft:true,body:'signed release'}, assets);
  await assert.rejects(publishRelease({...api,context,tag:'v0.5.0',kind:'signed'}), /Cannot publish/);
  assert.equal(api.calls.length,0);
  assets.push({name:'latest.json'});
  await publishRelease({...api,context,tag:'v0.5.0',kind:'signed'});
  assert.equal(api.calls.at(-1)[1].make_latest,'true');
  assert.equal(api.calls.at(-1)[1].draft,false);
  assert.equal(api.calls.at(-1)[1].prerelease,false);
});

test('missing staged release and missing platform installers cannot be published', async () => {
  await assert.rejects(publishRelease({...fake(null),context,tag:'v0.5.0',kind:'signed'}), /No staged release/);
  const api = fake({id:1,draft:true,body:'signed release'},[{name:'windows.exe'},{name:'latest.json'}]);
  await assert.rejects(publishRelease({...api,context,tag:'v0.5.0',kind:'signed'}), /Cannot publish/);
  assert.equal(api.calls.length,0);
});
