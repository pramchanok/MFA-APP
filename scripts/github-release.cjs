const fs = require('node:fs/promises');
const path = require('node:path');

const unsignedMarker = 'Unsigned test installers. Updater is disabled.';

async function assertDraftAllowed({ github, context, tag, kind }) {
  let release;
  try {
    ({ data: release } = await github.rest.repos.getReleaseByTag({ ...context.repo, tag }));
  } catch (error) {
    if (error.status !== 404) throw error;
    // The tag endpoint returns published releases. Find drafts through the
    // authenticated, paginated listing so uploads can resume and publish.
    const releases = await github.paginate(github.rest.repos.listReleases, { ...context.repo, per_page: 100 });
    release = releases.find((candidate) => candidate.tag_name === tag);
  }
  if (!release) return null;
  if (!release.draft) throw new Error(`${tag} is already published. Increase the app version; published releases are never overwritten.`);
  if ((kind === 'unsigned' && !release.body?.includes(unsignedMarker)) || (kind === 'signed' && release.body?.includes(unsignedMarker))) {
    throw new Error('This tag belongs to a different kind of draft. Delete the draft or increase the app version before switching release workflows.');
  }
  return release;
}

async function publishRelease({ github, context, core, tag, kind }) {
  const release = await assertDraftAllowed({ github, context, tag, kind });
  if (!release) throw new Error(`No staged release found for ${tag}.`);
  const assets = await github.paginate(github.rest.repos.listReleaseAssets, { ...context.repo, release_id: release.id });
  if (assets.filter((asset) => asset.name.endsWith('.exe')).length !== 1
    || assets.filter((asset) => asset.name.endsWith('.dmg')).length !== 2
    || (kind === 'signed' && !assets.some((asset) => asset.name === 'latest.json'))) {
    throw new Error('Cannot publish: expected all three installers and, for signed releases, latest.json.');
  }
  const { data } = await github.rest.repos.updateRelease({
    ...context.repo, release_id: release.id, draft: false, prerelease: false,
    // Unsigned installers must not replace the signed OTA endpoint at releases/latest.
    make_latest: kind === 'signed' ? 'true' : 'false',
  });
  await core.summary.addHeading('Release published').addLink('Open release', data.html_url).write();
}

async function createInstallerRelease({ github, context, core, tag, directory }) {
  const entries = await fs.readdir(directory, { recursive: true, withFileTypes: true });
  const installers = entries.filter((entry) => entry.isFile() && /\.(exe|dmg)$/.test(entry.name));
  if (installers.length !== 3 || new Set(installers.map((entry) => entry.name)).size !== 3
    || installers.filter((entry) => entry.name.endsWith('.exe')).length !== 1
    || installers.filter((entry) => entry.name.endsWith('.dmg')).length !== 2) {
    throw new Error('Expected three distinct installers: Windows x64, macOS Apple Silicon and macOS Intel.');
  }
  let release = await assertDraftAllowed({ github, context, tag, kind: 'unsigned' });
  // Never mix unsigned installers with updater artifacts from the signed workflow.
  if (!release) {
    const result = await github.rest.repos.createRelease({
      ...context.repo,
      tag_name: tag,
      target_commitish: context.sha,
      name: `MFA Desktop ${tag} (test installers)`,
      body: `${unsignedMarker}\n\nWindows x64 and macOS Apple Silicon / Intel. macOS builds are not notarized; signed releases use the separate signed workflow.\n\nSource commit: ${context.sha}`,
      draft: true,
      prerelease: false,
    });
    release = result.data;
  }
  const assets = await github.paginate(github.rest.repos.listReleaseAssets, { ...context.repo, release_id: release.id });
  for (const installer of installers) {
    const existing = assets.find((asset) => asset.name === installer.name);
    if (existing) await github.rest.repos.deleteReleaseAsset({ ...context.repo, asset_id: existing.id });
    const data = await fs.readFile(path.join(installer.parentPath, installer.name));
    await github.rest.repos.uploadReleaseAsset({
      ...context.repo, release_id: release.id, name: installer.name, data,
      headers: { 'content-type': 'application/octet-stream', 'content-length': data.length },
    });
  }
  await publishRelease({ github, context, core, tag, kind: 'unsigned' });
}

module.exports = { assertDraftAllowed, createInstallerRelease, publishRelease };
