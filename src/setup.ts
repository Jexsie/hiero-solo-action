import { which } from "@actions/io";
import { startGroup, addPath, endGroup, getInput } from "@actions/core";
import {
    find,
    downloadTool,
    cacheFile,
    extractTar,
    cacheDir,
} from "@actions/tool-cache";
import { promises as fs } from "fs";
import { join } from "path";
import { safeInfo, runCommand, safeExec, isVersionGte } from "./utils.js";
import {
    PYTHON_VERSION,
    PYTHON_DOWNLOAD_URL,
    WGET_VERSION,
    WGET_DOWNLOAD_URL,
    JAVA_VERSION,
    JAVA_DOWNLOAD_URL,
    KIND_VERSION,
    KIND_DOWNLOAD_URL,
    KUBECTL_VERSION,
    KUBECTL_DOWNLOAD_URL,
    JQ_VERSION,
    JQ_DOWNLOAD_URL,
    NODE_VERSION,
    NODE_DOWNLOAD_URL,
} from "./constants.js";

/**
 * Installs all system-level dependencies required by the action:
 * wget, python, Java 21, Kind, kubectl, and Solo CLI.
 */
export async function setupDependencies(): Promise<void> {
    startGroup("Installing System Dependencies");

    try {
        // Setup Python 3
        const pythonPath =
            (await which("python3", false)) || (await which("python", false));
        if (!pythonPath) {
            let cachedPython = find("python", PYTHON_VERSION);
            if (!cachedPython) {
                safeInfo(
                    `Installing Python ${PYTHON_VERSION} via python-build-standalone...`,
                );
                const downloadedPython =
                    await downloadTool(PYTHON_DOWNLOAD_URL);
                const extractedPythonDir = await extractTar(downloadedPython);
                cachedPython = await cacheDir(
                    join(extractedPythonDir, "python"),
                    "python",
                    PYTHON_VERSION,
                );
                safeInfo("Python installed successfully.");
            } else {
                safeInfo(`Python ${PYTHON_VERSION} found in tool-cache.`);
            }
            addPath(join(cachedPython, "bin"));
        } else {
            safeInfo(`Python is already installed at ${pythonPath}.`);
        }

        // Setup wget
        const wgetPath = await which("wget", false);
        if (!wgetPath) {
            let cachedWget = find("wget", WGET_VERSION);
            if (!cachedWget) {
                safeInfo("Installing wget via static binary...");
                const downloadedWget = await downloadTool(WGET_DOWNLOAD_URL);
                await runCommand(`chmod +x ${downloadedWget}`);
                cachedWget = await cacheFile(
                    downloadedWget,
                    "wget",
                    "wget",
                    WGET_VERSION,
                );
                safeInfo("wget installed successfully.");
            } else {
                safeInfo(`wget ${WGET_VERSION} found in tool-cache.`);
            }
            addPath(cachedWget);
        } else {
            safeInfo(`wget is already installed at ${wgetPath}.`);
        }

        // Setup Java 21 (Adoptium Temurin)
        const javaPath = await which("java", false);
        if (!javaPath) {
            let cachedJava = find("java", JAVA_VERSION);
            if (!cachedJava) {
                safeInfo("Installing OpenJDK 21 via Adoptium Temurin...");
                const downloadedJava = await downloadTool(JAVA_DOWNLOAD_URL);
                const extractedJavaDir = await extractTar(downloadedJava);

                // The tarball contains a single top-level folder like 'jdk-21.0.6+7'
                const dirContents = await fs.readdir(extractedJavaDir);
                const jdkDir =
                    dirContents.find((name) => name.startsWith("jdk-")) ??
                    dirContents[0];
                const javaHomePath = join(extractedJavaDir, jdkDir);

                cachedJava = await cacheDir(javaHomePath, "java", JAVA_VERSION);
                safeInfo(`Java installed at ${cachedJava}.`);
            } else {
                safeInfo(`Java ${JAVA_VERSION} found in tool-cache.`);
            }
            addPath(join(cachedJava, "bin"));
        } else {
            safeInfo(`Java is already installed at ${javaPath}.`);
        }

        // Setup Kind
        const kindPath = await which("kind", false);
        if (!kindPath) {
            let cachedKind = find("kind", KIND_VERSION);
            if (!cachedKind) {
                safeInfo(`Downloading Kind ${KIND_VERSION}...`);
                const downloadedKind = await downloadTool(KIND_DOWNLOAD_URL);
                await runCommand(`chmod +x ${downloadedKind}`);
                cachedKind = await cacheFile(
                    downloadedKind,
                    "kind",
                    "kind",
                    KIND_VERSION,
                );
            } else {
                safeInfo(`Kind ${KIND_VERSION} found in tool-cache.`);
            }
            addPath(cachedKind);
        } else {
            safeInfo(`Kind is already installed at ${kindPath}.`);
        }

        // Setup kubectl
        const kubectlPath = await which("kubectl", false);
        if (!kubectlPath) {
            let cachedKubectl = find("kubectl", KUBECTL_VERSION);
            if (!cachedKubectl) {
                safeInfo(`Downloading kubectl ${KUBECTL_VERSION}...`);
                const downloadedKubectl =
                    await downloadTool(KUBECTL_DOWNLOAD_URL);
                await runCommand(`chmod +x ${downloadedKubectl}`);
                cachedKubectl = await cacheFile(
                    downloadedKubectl,
                    "kubectl",
                    "kubectl",
                    KUBECTL_VERSION,
                );
            } else {
                safeInfo(`kubectl ${KUBECTL_VERSION} found in tool-cache.`);
            }
            addPath(cachedKubectl);
        } else {
            safeInfo(`kubectl is already installed at ${kubectlPath}.`);
        }

        // Setup jq
        const jqPath = await which("jq", false);
        if (!jqPath) {
            let cachedJq = find("jq", JQ_VERSION);
            if (!cachedJq) {
                safeInfo(`Downloading jq ${JQ_VERSION}...`);
                const downloadedJq = await downloadTool(JQ_DOWNLOAD_URL);
                await runCommand(`chmod +x ${downloadedJq}`);
                cachedJq = await cacheFile(
                    downloadedJq,
                    "jq",
                    "jq",
                    JQ_VERSION,
                );
                safeInfo("jq installed successfully.");
            } else {
                safeInfo(`jq ${JQ_VERSION} found in tool-cache.`);
            }
            addPath(cachedJq);
        } else {
            safeInfo(`jq is already installed at ${jqPath}.`);
        }

        // Setup Node.js / npm
        const npmPath = await which("npm", false);
        if (!npmPath) {
            let cachedNode = find("node", NODE_VERSION);
            if (!cachedNode) {
                safeInfo(
                    "Installing Node.js (includes npm) via official tarball...",
                );
                const downloadedNode = await downloadTool(NODE_DOWNLOAD_URL);
                const extractedNodeDir = await extractTar(
                    downloadedNode,
                    undefined,
                    ["xJ"],
                );

                const nodeDir = `node-v${NODE_VERSION}-linux-x64`;
                const nodeHomePath = join(extractedNodeDir, nodeDir);

                cachedNode = await cacheDir(nodeHomePath, "node", NODE_VERSION);
                safeInfo("Node.js and npm installed successfully.");
            } else {
                safeInfo(`Node.js ${NODE_VERSION} found in tool-cache.`);
            }
            addPath(join(cachedNode, "bin"));
        } else {
            safeInfo(`npm is already installed at ${npmPath}.`);
        }

        // Install Solo CLI
        const inputSoloVersion = getInput("soloVersion");
        const soloVersion = inputSoloVersion ? inputSoloVersion : "latest";
        safeInfo(`Installing Solo CLI version: ${soloVersion}`);
        await runCommand(`npm install -g @hashgraph/solo@${soloVersion}`);

        safeInfo("✅ All dependencies installed successfully.");
    } catch (error: unknown) {
        throw new Error(
            `Dependency setup failed: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
        );
    } finally {
        endGroup();
    }
}

/**
 * Detects the installed Solo CLI version and whether it is >= 0.44.0.
 */
export async function checkSoloVersion(): Promise<boolean> {
    try {
        let stdout = "";
        let stderr = "";

        await safeExec("solo", ["--version"], {
            listeners: {
                stdout: (data: Buffer) => {
                    stdout += data.toString();
                },
                stderr: (data: Buffer) => {
                    stderr += data.toString();
                },
            },
            ignoreReturnCode: true,
            silent: true,
        });

        const combined = `${stdout}\n${stderr}`.trim();
        safeInfo(`[checkSoloVersion] raw output: ${combined}`);

        // Match "Version<whitespace>:<whitespace>X.Y.Z" from the Solo banner
        const match = combined.match(/Version\s*:\s*(\d+\.\d+\.\d+)/);

        if (!match) {
            safeInfo(
                `[checkSoloVersion] Could not parse version. Assuming >= 0.44.0.`,
            );
            return true;
        }

        const version = match[1];
        const ge0440 = isVersionGte(version, "0.44.0");
        safeInfo(`[checkSoloVersion] version=${version}, >= 0.44.0: ${ge0440}`);
        return ge0440;
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        safeInfo(
            `[checkSoloVersion] Failed to detect version: ${msg}. Assuming >= 0.44.0.`,
        );
        return true;
    }
}
