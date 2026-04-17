import { which } from "@actions/io";
import { startGroup, addPath, endGroup, getInput } from "@actions/core";
import {
  downloadTool,
  cacheFile,
  extractTar,
  cacheDir,
} from "@actions/tool-cache";
import { readdirSync } from "fs";
import { join } from "path";
import { safeInfo, safeExec, isVersionGte } from "./utils.js";
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
      safeInfo("Installing Python 3.12 via python-build-standalone...");
      const downloadedPython = await downloadTool(PYTHON_DOWNLOAD_URL);
      const extractedPythonDir = await extractTar(downloadedPython);
      const cachedPython = await cacheDir(
        join(extractedPythonDir, "python"),
        "python",
        PYTHON_VERSION,
      );
      addPath(join(cachedPython, "bin"));
      safeInfo("Python installed successfully.");
    } else {
      safeInfo(`Python is already installed at ${pythonPath}.`);
    }

    // Setup wget
    const wgetPath = await which("wget", false);
    if (!wgetPath) {
      safeInfo("Installing wget via static binary...");
      const downloadedWget = await downloadTool(WGET_DOWNLOAD_URL);
      await safeExec("chmod", ["+x", downloadedWget]);
      const cachedWget = await cacheFile(
        downloadedWget,
        "wget",
        "wget",
        WGET_VERSION,
      );
      addPath(cachedWget);
      safeInfo("wget installed successfully.");
    } else {
      safeInfo(`wget is already installed at ${wgetPath}.`);
    }

    // Setup Java 21 (Adoptium Temurin)
    const javaPath = await which("java", false);
    if (!javaPath) {
      safeInfo("Installing OpenJDK 21 via Adoptium Temurin...");
      const downloadedJava = await downloadTool(JAVA_DOWNLOAD_URL);
      const extractedJavaDir = await extractTar(downloadedJava);

      // The tarball contains a single top-level folder like 'jdk-21.0.6+7'
      const dirContents = readdirSync(extractedJavaDir);
      const jdkDir =
        dirContents.find((name) => name.startsWith("jdk-")) || dirContents[0];
      const javaHomePath = join(extractedJavaDir, jdkDir);

      const cachedJava = await cacheDir(
        javaHomePath,
        "java",
        JAVA_VERSION,
      );
      addPath(join(cachedJava, "bin"));
      safeInfo(`Java installed at ${cachedJava}.`);
    } else {
      safeInfo(`Java is already installed at ${javaPath}.`);
    }

    // Setup Kind
    const kindPath = await which("kind", false);
    if (!kindPath) {
      safeInfo(`Downloading Kind ${KIND_VERSION}...`);
      const downloadedKind = await downloadTool(KIND_DOWNLOAD_URL);
      await safeExec("chmod", ["+x", downloadedKind]);
      const cachedKind = await cacheFile(
        downloadedKind,
        "kind",
        "kind",
        KIND_VERSION,
      );
      addPath(cachedKind);
    }

    // Setup kubectl
    const kubectlPath = await which("kubectl", false);
    if (!kubectlPath) {
      safeInfo(`Downloading kubectl ${KUBECTL_VERSION}...`);
      const downloadedKubectl = await downloadTool(KUBECTL_DOWNLOAD_URL);
      await safeExec("chmod", ["+x", downloadedKubectl]);
      const cachedKubectl = await cacheFile(
        downloadedKubectl,
        "kubectl",
        "kubectl",
        KUBECTL_VERSION,
      );
      addPath(cachedKubectl);
    }

    // Install Solo CLI
    const soloVersion = getInput("soloVersion") || "latest";
    safeInfo(`Installing Solo CLI version: ${soloVersion}`);
    await safeExec(`npm install -g @hashgraph/solo@${soloVersion}`);

    safeInfo("✅ All dependencies installed successfully.");
  } catch (error) {
    throw new Error(
      `Dependency setup failed: ${error instanceof Error ? error.message : String(error)}`,
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
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    safeInfo(
      `[checkSoloVersion] Failed to detect version: ${msg}. Assuming >= 0.44.0.`,
    );
    return true;
  }
}
