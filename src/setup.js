const core = require('@actions/core');
const exec = require('@actions/exec');
const tc = require('@actions/tool-cache');
const path = require('path');
const fs = require('fs');

async function run() {
    try {
        let unityVersion = core.getInput('unity-version');
        let unityVersionChangeset = core.getInput('unity-version-changeset');
        const unityModules = getInputAsArray('unity-modules');
        const unityModulesChild = getInputAsBool('unity-modules-child');
        const installPath = core.getInput('install-path');
        const projectPath = core.getInput('project-path');

        if (!unityVersion) {
            [unityVersion, unityVersionChangeset] = findProjectVersion(projectPath);
        } else if (!unityVersionChangeset) {
            unityVersionChangeset = await findVersionChangeset(unityVersion);
        }
        const unityHubPath = await installUnityHub();
        const unityPath = await installUnityEditor(unityHubPath, installPath, unityVersion, unityVersionChangeset);
        await installUnityModules(unityHubPath, unityVersion, unityModules, unityModulesChild);

        core.setOutput('unity-version', unityVersion);
        core.setOutput('unity-path', unityPath);
        core.exportVariable('UNITY_PATH', unityPath);
    } catch (error) {
        core.setFailed(error.message);
    }
}

async function installUnityHub() {
    let unityHubPath = '';
    if (process.platform === 'linux') {

        unityHubPath = `${process.env.HOME}/Unity Hub/UnityHub.AppImage`;
        if (!fs.existsSync(unityHubPath)) {
            const installerPath = await tc.downloadTool('https://public-cdn.cloud.unity3d.com/hub/prod/UnityHub.AppImage');
            await execute(`mkdir -p "${process.env.HOME}/Unity Hub" "${process.env.HOME}/.config/Unity Hub"`);
            await execute(`mv "${installerPath}" "${unityHubPath}"`);
            await execute(`chmod +x "${unityHubPath}"`);
            await execute(`touch "${process.env.HOME}/.config/Unity Hub/eulaAccepted"`);
            try {
                await execute('sudo apt-get update');
                await execute('sudo apt-get install -y libgconf-2-4 libasound2 libgtk2.0-0 libgtk-3-0 libnss3 zenity xvfb');
            } catch {
                // skip 'command not found' error
            }
        }

    } else if (process.platform === 'darwin') {

        unityHubPath = '/Applications/Unity Hub.app/Contents/MacOS/Unity Hub';
        if (!fs.existsSync(unityHubPath)) {
            const installerPath = await tc.downloadTool('https://public-cdn.cloud.unity3d.com/hub/prod/UnityHubSetup.dmg');
            await execute(`sudo hdiutil mount "${installerPath}"`);
            const hubVolume = (await execute('ls /Volumes')).match(/Unity Hub.*/)[0];
            await execute(`ditto "/Volumes/${hubVolume}/Unity Hub.app" "/Applications/Unity Hub.app"`);
            await execute(`sudo hdiutil detach "/Volumes/${hubVolume}"`);
            await execute(`rm "${installerPath}"`);
        }

    } else if (process.platform === 'win32') {

        unityHubPath = 'C:/Program Files/Unity Hub/Unity Hub.exe';
        if (!fs.existsSync(unityHubPath)) {
            const installerPath = await tc.downloadTool('https://public-cdn.cloud.unity3d.com/hub/prod/UnityHubSetup.exe');
            await execute(`"${installerPath}" /s`);
            await execute(`del "${installerPath}"`);
        }

    }
    else throw new Error('Unknown plarform');
    return unityHubPath;
}

async function installUnityEditor(unityHubPath, installPath, unityVersion, unityVersionChangeset) {
    let unityPath = await findUnity(unityHubPath, unityVersion);
    if (!unityPath) {
        if (installPath) {
            await executeHub(unityHubPath, `install-path --set ${installPath}`);
        }
        await executeHub(unityHubPath, `install --version ${unityVersion} --changeset ${unityVersionChangeset}`);
        unityPath = await findUnity(unityHubPath, unityVersion);
    }
    return unityPath;
}

async function installUnityModules(unityHubPath, unityVersion, unityModules, unityModulesChild) {
    const modulesArgs = unityModules.map(s => `--module ${s.toLowerCase()}`).join(' ');
    const childModulesArg = unityModulesChild ? '--childModules' : '';
    await executeHub(unityHubPath, `install-modules --version ${unityVersion} ${modulesArgs} ${childModulesArg}`);
}

async function findUnity(unityHubPath, unityVersion) {
    let unityPath = '';
    const output = await executeHub(unityHubPath, `editors --installed`);
    const match = output.match(new RegExp(`${unityVersion} , installed at (.+)`));
    if (match) {
        unityPath = match[1];
        if (unityPath && process.platform === 'darwin') {
            unityPath += '/Contents/MacOS/Unity';
        }
    }
    return unityPath;
}

function findProjectVersion(projectPath) {
    const filePath = path.join(projectPath, 'ProjectSettings/ProjectVersion.txt');
    if (fs.existsSync(filePath)) {
        const fileText = fs.readFileSync(filePath, 'utf8');
        const match = fileText.match(/m_EditorVersionWithRevision: (.+) \((.+)\)/);
        const version = match[1];
        const changeset = match[2];
        return [version, changeset];
    } else {
        throw new Error(`Project not found at path: ${projectPath}`);
    }
}

async function findVersionChangeset(unityVersion) {
    let changeset = '';
    try {
        let versionPageUrl;
        if (unityVersion.includes('a')) {
            versionPageUrl = 'https://unity3d.com/unity/alpha/' + unityVersion;
        } else if (unityVersion.includes('b')) {
            versionPageUrl = 'https://unity3d.com/unity/beta/' + unityVersion;
        } else if (unityVersion.includes('f')) {
            versionPageUrl = 'https://unity3d.com/unity/whats-new/' + unityVersion.match(/[.0-9]+/)[0];
        }
        const pagePath = await tc.downloadTool(versionPageUrl); // support retry
        const pageText = fs.readFileSync(pagePath, 'utf8');
        const match = pageText.match(new RegExp(`unityhub://${unityVersion}/([a-z0-9]+)`)) || pageText.match(/Changeset:<\/span>[ \n]*([a-z0-9]{12})/);
        changeset = match[1];
    } catch (error) {
        core.error(error);
    }
    if (!changeset) {
        throw new Error("Can't find Unity version changeset automatically");
    }
    return changeset;
}

async function executeHub(unityHubPath, args) {
    if (process.platform === 'linux') {
        return await execute(`sudo xvfb-run --auto-servernum "${unityHubPath}" --no-sandbox --headless ${args}`);
    } else if (process.platform === 'darwin') {
        return await execute(`sudo "${unityHubPath}" -- --headless ${args}`);
    } else if (process.platform === 'win32') {
        // unityhub always return exit code 1
        return await execute(`"${unityHubPath}" -- --headless ${args}`, true);
    }
}

async function execute(command, ignoreReturnCode) {
    let stdout = '';
    await exec.exec(command, [], {
        ignoreReturnCode: ignoreReturnCode,
        listeners: {
            stdout: buffer => stdout += buffer.toString()
        }
    });
    console.log(); // new line
    return stdout;
}

function getInputAsArray(name, options) {
    return core
        .getInput(name, options)
        .split("\n")
        .map(s => s.trim())
        .filter(x => x !== "");
}

function getInputAsBool(name, options) {
    return core.getInput(name, options).toLowerCase() === 'true';
}

run();
