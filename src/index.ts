import { exec } from "@actions/exec";
import { which } from "@actions/io";
import {
  setFailed,
  saveState,
  getInput,
  startGroup,
  addPath,
  endGroup,
} from "@actions/core";
import { downloadTool, cacheFile } from "@actions/tool-cache";
import { existsSync } from "fs";
import { join } from "path";
import {
  safeInfo,
  safeExec,
  safeGetInput,
  safeSetOutput,
  safeReadFileSync,
  portForwardIfExists,
  extractAccountAsJson,
} from "./utils.js";

interface AccountInfo {
  accountId: string;
  publicKey: string;
  balance: number;
}

/**
 * Compares two semver-like version strings.
 * Returns true if `version` >= `target`.
 */
function isVersionGte(version: string, target: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const [aMajor = 0, aMinor = 0, aPatch = 0] = parse(version);
  const [bMajor = 0, bMinor = 0, bPatch = 0] = parse(target);

  if (aMajor !== bMajor) return aMajor > bMajor;
  if (aMinor !== bMinor) return aMinor > bMinor;
  return aPatch >= bPatch;
}

/**
 * Detects the installed Solo CLI version and whether it is >= 0.44.0.
 *
 * Handles multiple output formats:
 *  - oclif default:  "@hashgraph/solo/0.65.0 linux-x64 node-v22.x.x"
 *  - legacy banner:  "Version 0.65.0" or "Solo Version 0.65.0"
 *  - bare semver:    "0.65.0"
 */
async function checkSoloVersion(): Promise<boolean> {
  try {
    let stdout = "";
    let stderr = "";

    await exec("solo", ["--version"], {
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

    let version: string | undefined;

    // Pattern 1: oclif format "@hashgraph/solo/X.Y.Z" or "solo/X.Y.Z"
    const oclif = combined.match(/solo\/(\d+\.\d+\.\d+)/i);
    if (oclif) {
      version = oclif[1];
    }

    // Pattern 2: "Version X.Y.Z"
    if (!version) {
      const banner = combined.match(/Version\s+(\d+\.\d+\.\d+)/i);
      if (banner) {
        version = banner[1];
      }
    }

    // Pattern 3: bare semver anywhere in the output
    if (!version) {
      const bare = combined.match(/(\d+\.\d+\.\d+)/);
      if (bare) {
        version = bare[1];
      }
    }

    if (!version) {
      safeInfo(
        `[checkSoloVersion] Could not parse version. Assuming >= 0.44.0.`,
      );
      return true;
    }

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

/**
 * Installs all system-level dependencies required by the action:
 * wget, python, Java 21, Kind, kubectl, and Solo CLI.
 */
async function setupDependencies(): Promise<void> {
  startGroup("Installing System Dependencies");

  try {
    // 1. Install wget & Python (Standard OS packages)
    safeInfo(
      "Updating apt and installing wget, Python, Java 21, Kind, and kubectl",
    );
    await exec("sudo apt-get update");
    await exec("sudo apt-get install -y wget python3.10");

    // 2. Setup Java 21 (Temurin)
    const javaPath = await which("java", false);
    if (!javaPath) {
      safeInfo("Installing OpenJDK 21...");
      await exec("sudo apt-get install -y openjdk-21-jdk");
    }

    // 3. Setup Kind
    const kindVersion = "v0.29.0";
    const kindPath = await which("kind", false);
    if (!kindPath) {
      safeInfo(`Downloading Kind ${kindVersion}...`);
      const kindUrl = `https://kind.sigs.k8s.io/dl/${kindVersion}/kind-linux-amd64`;
      const downloadedKind = await downloadTool(kindUrl);
      await exec("chmod", ["+x", downloadedKind]);
      const cachedKind = await cacheFile(
        downloadedKind,
        "kind",
        "kind",
        kindVersion,
      );
      addPath(cachedKind);
    }

    // 4. Setup kubectl
    const k8sVersion = "v1.32.2";
    const kubectlUrl = `https://dl.k8s.io/release/${k8sVersion}/bin/linux/amd64/kubectl`;
    const downloadedKubectl = await downloadTool(kubectlUrl);
    await exec("chmod", ["+x", downloadedKubectl]);
    const cachedKubectl = await cacheFile(
      downloadedKubectl,
      "kubectl",
      "kubectl",
      k8sVersion,
    );
    addPath(cachedKubectl);

    // 5. Install Solo CLI
    const soloVersion = getInput("soloVersion") || "latest";
    safeInfo(`Installing Solo CLI version: ${soloVersion}`);
    await exec(`sudo npm install -g @hashgraph/solo@${soloVersion}`);

    safeInfo("✅ All dependencies installed successfully.");
  } catch (error) {
    throw new Error(
      `Dependency setup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    endGroup();
  }
}

// ---------------------------------------------------------------------------
// Solo CLI Helper Functions (version-aware)
// ---------------------------------------------------------------------------

/**
 * Creates a Kubernetes cluster using kind
 */
async function createKindCluster(clusterName: string): Promise<void> {
  await safeExec("kind", ["create", "cluster", "-n", clusterName]);
}

/**
 * Initializes Solo CLI configuration
 */
async function initializeSolo(): Promise<void> {
  await safeExec("solo", ["init", "--dev"]);
}

/**
 * Connects Solo CLI to the kind cluster
 */
async function connectSoloToCluster(
  clusterName: string,
  soloGe0440: boolean,
): Promise<void> {
  if (soloGe0440) {
    await safeExec("solo", [
      "cluster-ref",
      "config",
      "connect",
      "--cluster-ref",
      `kind-${clusterName}`,
      "--context",
      `kind-${clusterName}`,
      "--dev",
    ]);
  } else {
    await safeExec("solo", [
      "cluster-ref",
      "connect",
      "--cluster-ref",
      `kind-${clusterName}`,
      "--context",
      `kind-${clusterName}`,
      "--dev",
    ]);
  }
}

/**
 * Creates a new Solo deployment
 */
async function createSoloDeployment(
  namespace: string,
  deployment: string,
  soloGe0440: boolean,
): Promise<void> {
  if (soloGe0440) {
    await safeExec("solo", [
      "deployment",
      "config",
      "create",
      "-n",
      namespace,
      "--deployment",
      deployment,
      "--dev",
    ]);
  } else {
    await safeExec("solo", [
      "deployment",
      "create",
      "-n",
      namespace,
      "--deployment",
      deployment,
      "--dev",
    ]);
  }
}

/**
 * Adds cluster to deployment
 */
async function addClusterToDeployment(
  deployment: string,
  clusterName: string,
  numNodes: number,
  soloGe0440: boolean,
): Promise<void> {
  if (soloGe0440) {
    await safeExec("solo", [
      "deployment",
      "cluster",
      "attach",
      "--deployment",
      deployment,
      "--cluster-ref",
      `kind-${clusterName}`,
      "--num-consensus-nodes",
      String(numNodes),
      "--dev",
    ]);
  } else {
    await safeExec("solo", [
      "deployment",
      "add-cluster",
      "--deployment",
      deployment,
      "--cluster-ref",
      `kind-${clusterName}`,
      "--num-consensus-nodes",
      String(numNodes),
      "--dev",
    ]);
  }
}

/**
 * Generates keys for the consensus nodes
 */
async function generateNodeKeys(
  deployment: string,
  nodeIds: string,
  soloGe0440: boolean,
): Promise<void> {
  if (soloGe0440) {
    await safeExec("solo", [
      "keys",
      "consensus",
      "generate",
      "--gossip-keys",
      "--tls-keys",
      "-i",
      nodeIds,
      "--deployment",
      deployment,
      "--dev",
    ]);
  } else {
    await safeExec("solo", [
      "node",
      "keys",
      "--gossip-keys",
      "--tls-keys",
      "-i",
      nodeIds,
      "--deployment",
      deployment,
      "--dev",
    ]);
  }
}

/**
 * Sets up the Solo cluster
 */
async function setupSoloCluster(
  clusterName: string,
  soloGe0440: boolean,
): Promise<void> {
  if (soloGe0440) {
    await safeExec("solo", [
      "cluster-ref",
      "config",
      "setup",
      "-s",
      clusterName,
      "--dev",
    ]);
  } else {
    await safeExec("solo", [
      "cluster-ref",
      "setup",
      "-s",
      clusterName,
      "--dev",
    ]);
  }
}

/**
 * Deploys the network
 */
async function deployNetwork(
  deployment: string,
  nodeIds: string,
  hieroVersion: string,
  soloGe0440: boolean,
): Promise<void> {
  if (soloGe0440) {
    await safeExec("solo", [
      "consensus",
      "network",
      "deploy",
      "-i",
      nodeIds,
      "--deployment",
      deployment,
      "--release-tag",
      hieroVersion,
      "--dev",
    ]);
  } else {
    await safeExec("solo", [
      "network",
      "deploy",
      "-i",
      nodeIds,
      "--deployment",
      deployment,
      "--release-tag",
      hieroVersion,
      "--dev",
    ]);
  }
}

/**
 * Sets up the consensus nodes
 */
async function setupNode(
  deployment: string,
  nodeIds: string,
  hieroVersion: string,
  soloGe0440: boolean,
): Promise<void> {
  if (soloGe0440) {
    await safeExec("solo", [
      "consensus",
      "node",
      "setup",
      "-i",
      nodeIds,
      "--deployment",
      deployment,
      "--release-tag",
      hieroVersion,
      "--quiet-mode",
      "--dev",
    ]);
  } else {
    await safeExec("solo", [
      "node",
      "setup",
      "-i",
      nodeIds,
      "--deployment",
      deployment,
      "--release-tag",
      hieroVersion,
      "--quiet-mode",
      "--dev",
    ]);
  }
}

/**
 * Starts the consensus nodes
 */
async function startNode(
  deployment: string,
  nodeIds: string,
  soloGe0440: boolean,
): Promise<void> {
  if (soloGe0440) {
    await safeExec("solo", [
      "consensus",
      "node",
      "start",
      "-i",
      nodeIds,
      "--deployment",
      deployment,
      "--dev",
    ]);
  } else {
    await safeExec("solo", [
      "node",
      "start",
      "-i",
      nodeIds,
      "--deployment",
      deployment,
      "--dev",
    ]);
  }
}

// ---------------------------------------------------------------------------
// High-level orchestration functions
// ---------------------------------------------------------------------------

/**
 * Adds entries to /etc/hosts for the consensus nodes.
 */
async function setupHostsEntries(
  namespace: string,
  dualMode: boolean,
): Promise<void> {
  try {
    // Check if we have sudo access
    const sudoCheck = await exec("sudo", ["-n", "true"], {
      ignoreReturnCode: true,
    });

    if (sudoCheck === 0) {
      const entries = [
        `127.0.0.1 network-node1-svc.${namespace}.svc.cluster.local`,
        `127.0.0.1 envoy-proxy-node1-svc.${namespace}.svc.cluster.local`,
      ];

      if (dualMode) {
        entries.push(
          `127.0.0.1 network-node2-svc.${namespace}.svc.cluster.local`,
          `127.0.0.1 envoy-proxy-node2-svc.${namespace}.svc.cluster.local`,
        );
      }

      for (const entry of entries) {
        await safeExec("bash", [
          "-c",
          `echo "${entry}" | sudo tee -a /etc/hosts`,
        ]);
      }
      safeInfo("Successfully added entries to /etc/hosts");
    } else {
      safeInfo(
        "⚠️  No sudo access available, skipping /etc/hosts update. Nodes can still be accessed via localhost.",
      );
    }
  } catch {
    safeInfo("⚠️  Failed to update /etc/hosts, continuing...");
  }
}

/**
 * Deploys a Solo test network with full support for:
 * - Solo version-aware commands (>= 0.44.0 vs < 0.44.0)
 * - Dual mode (1 or 2 consensus nodes)
 * - /etc/hosts entries
 * - Configurable port-forwarding (HAProxy, gRPC proxy)
 */
async function deploySoloTestNetwork(soloGe0440: boolean): Promise<void> {
  const clusterName = "solo-e2e";
  const namespace = "solo";
  const deployment = "solo-deployment";
  const hieroVersion = safeGetInput("hieroVersion");
  const dualMode = safeGetInput("dualMode") === "true";
  const haproxyPort = safeGetInput("haproxyPort") || "50211";
  const grpcProxyPort = safeGetInput("grpcProxyPort") || "9998";
  const dualModeGrpcProxyPort =
    safeGetInput("dualModeGrpcProxyPort") || "9999";

  if (!hieroVersion) {
    safeInfo("Hiero version not found, skipping deployment");
    return;
  }

  const numNodes = dualMode ? 2 : 1;
  const nodeIds = dualMode ? "node1,node2" : "node1";

  safeInfo(
    `[deploySoloTestNetwork] soloGe0440=${soloGe0440}, dualMode=${dualMode}, nodes=${numNodes}, nodeIds=${nodeIds}, hieroVersion=${hieroVersion}`,
  );

  try {
    saveState("clusterName", clusterName);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to save cluster name state: ${errorMessage}`);
  }

  try {
    await createKindCluster(clusterName);
    await initializeSolo();
    await connectSoloToCluster(clusterName, soloGe0440);
    await createSoloDeployment(namespace, deployment, soloGe0440);
    await addClusterToDeployment(
      deployment,
      clusterName,
      numNodes,
      soloGe0440,
    );
    await generateNodeKeys(deployment, nodeIds, soloGe0440);
    await setupSoloCluster(clusterName, soloGe0440);
    await deployNetwork(deployment, nodeIds, hieroVersion, soloGe0440);
    await setupNode(deployment, nodeIds, hieroVersion, soloGe0440);
    await startNode(deployment, nodeIds, soloGe0440);

    // Debug: List services in the solo namespace
    safeInfo(`Listing services in namespace ${namespace}:`);
    await safeExec("kubectl", ["get", "svc", "-n", namespace]);

    // Add /etc/hosts entries
    await setupHostsEntries(namespace, dualMode);

    // Port forward HAProxy for node1
    await portForwardIfExists(
      "haproxy-node1-svc",
      `${haproxyPort}:50211`,
      namespace,
    );

    // Port forwards for node2 if dual mode is enabled
    if (dualMode) {
      await portForwardIfExists(
        "haproxy-node2-svc",
        "51211:50211",
        namespace,
      );
      safeInfo("HAProxy for node2 is accessible on port 51211");

      await portForwardIfExists(
        "envoy-proxy-node2-svc",
        `${dualModeGrpcProxyPort}:8080`,
        namespace,
      );
      safeInfo(
        `gRPC proxy for node2 is accessible on port ${dualModeGrpcProxyPort}`,
      );
    }

    // Port forward gRPC proxy for node1
    await portForwardIfExists(
      "envoy-proxy-node1-svc",
      `${grpcProxyPort}:8080`,
      namespace,
    );
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to deploy Solo test network: ${errorMessage}`);
  }
}

/**
 * Deploys a Mirror Node.
 * Also deploys when installRelay is true since the relay expects
 * mirror-ingress-controller.
 */
async function deployMirrorNode(soloGe0440: boolean): Promise<void> {
  const installMirrorNode = safeGetInput("installMirrorNode") === "true";
  const installRelay = safeGetInput("installRelay") === "true";

  // Mirror node is required when installRelay is true
  if (!installMirrorNode && !installRelay) return;

  const namespace = "solo";
  const deployment = "solo-deployment";
  const clusterName = "solo-e2e";
  const version = safeGetInput("mirrorNodeVersion");
  const portRest = safeGetInput("mirrorNodePortRest") || "5551";
  const portGrpc = safeGetInput("mirrorNodePortGrpc") || "5600";
  const portWeb3 = safeGetInput("mirrorNodePortWeb3Rest") || "8545";
  const javaRestApiPort = safeGetInput("javaRestApiPort") || "8084";

  // Relay requires mirror-ingress-controller; --enable-ingress installs it.
  const enableIngress = installRelay;

  try {
    const baseArgs: string[] = [];

    if (soloGe0440) {
      baseArgs.push(
        "mirror",
        "node",
        "add",
        "--cluster-ref",
        `kind-${clusterName}`,
        "--deployment",
        deployment,
        "--mirror-node-version",
        version,
        "--pinger",
      );
    } else {
      baseArgs.push(
        "mirror-node",
        "deploy",
        "--cluster-ref",
        `kind-${clusterName}`,
        "--deployment",
        deployment,
        "--mirror-node-version",
        version,
        "--pinger",
      );
    }

    if (enableIngress) {
      baseArgs.push("--enable-ingress");
    }

    baseArgs.push("--dev");

    await safeExec("solo", baseArgs);

    // Debug: List services in the solo namespace
    safeInfo(`Listing services in namespace ${namespace}:`);
    await safeExec("kubectl", ["get", "svc", "-n", namespace]);

    // Port forward Mirror Node services
    await portForwardIfExists("mirror-1-rest", `${portRest}:80`, namespace);
    await portForwardIfExists(
      "mirror-1-grpc",
      `${portGrpc}:5600`,
      namespace,
    );
    await portForwardIfExists(
      "mirror-1-web3",
      `${portWeb3}:80`,
      namespace,
    );
    await portForwardIfExists(
      "mirror-1-restjava",
      `${javaRestApiPort}:80`,
      namespace,
    );
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to deploy Mirror Node: ${errorMessage}`);
  }
}

/**
 * Deploys the JSON-RPC Relay.
 */
async function deployRelay(soloGe0440: boolean): Promise<void> {
  const installRelay = safeGetInput("installRelay") === "true";
  if (!installRelay) return;

  const namespace = "solo";
  const deployment = "solo-deployment";
  const relayPort = safeGetInput("relayPort") || "7546";

  try {
    const baseArgs: string[] = [];

    if (soloGe0440) {
      baseArgs.push(
        "relay",
        "node",
        "add",
        "-i",
        "node1",
        "--deployment",
        deployment,
        "--dev",
      );
    } else {
      baseArgs.push(
        "relay",
        "deploy",
        "-i",
        "node1",
        "--deployment",
        deployment,
        "--dev",
      );
    }

    // Add --values-file if relay-low-resources.yaml exists
    const workspacePath = process.env.GITHUB_WORKSPACE || ".";
    const relayValuesFile = join(workspacePath, "relay-low-resources.yaml");
    if (existsSync(relayValuesFile)) {
      baseArgs.push("--values-file", relayValuesFile);
    }

    await safeExec("solo", baseArgs);
    safeInfo("JSON-RPC-Relay installed successfully");

    // Debug: List services in the solo namespace
    safeInfo(`Listing services in namespace ${namespace}:`);
    await safeExec("kubectl", ["get", "svc", "-n", namespace]);

    // Port forward the Relay service
    await portForwardIfExists(
      "relay-node1-hedera-json-rpc-relay",
      `${relayPort}:7546`,
      namespace,
    );
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    safeInfo(
      `Relay service deployment failed: ${errorMessage}, continuing...`,
    );
  }
}

/**
 * Creates an account (ECDSA or ED25519) with Solo version-aware commands.
 */
async function createAccount(
  type: "ecdsa" | "ed25519",
  soloGe0440: boolean,
): Promise<void> {
  const namespace = "solo";
  const deployment = "solo-deployment";
  const outputFile = `account_create_output_${type}.txt`;
  const hbarAmount = safeGetInput("hbarAmount") || "10000000";

  safeInfo(`Creating ${type.toUpperCase()} account...`);

  try {
    // Build the create command
    const createArgs: string[] = [];
    if (soloGe0440) {
      createArgs.push("ledger", "account", "create");
    } else {
      createArgs.push("account", "create");
    }

    if (type === "ecdsa") {
      createArgs.push("--generate-ecdsa-key");
    }

    createArgs.push("--deployment", deployment, "--dev");

    // Execute and redirect output to file
    const createCommand = `solo ${createArgs.join(" ")} > ${outputFile}`;
    await safeExec("bash", ["-c", createCommand]);

    // Read and parse the output
    const content = safeReadFileSync(outputFile);
    const accountJson = extractAccountAsJson(content);
    const accountInfo = JSON.parse(accountJson) as AccountInfo;
    const { accountId, publicKey } = accountInfo;

    if (!accountId || !publicKey) {
      safeInfo(
        "Account ID or public key not found, skipping account creation",
      );
      return;
    }

    // Get the private key from the Kubernetes secret
    const privateKeyCmd = `kubectl get secret account-key-${accountId} -n ${namespace} -o jsonpath='{.data.privateKey}' | base64 -d | xargs`;
    let privateKey = "";
    await safeExec("bash", ["-c", privateKeyCmd], {
      listeners: {
        stdout: (data: Buffer) => {
          privateKey += data.toString();
        },
      },
    });

    // Update the account with the specified hbar amount
    const updateArgs: string[] = [];
    if (soloGe0440) {
      updateArgs.push("ledger", "account", "update");
    } else {
      updateArgs.push("account", "update");
    }
    updateArgs.push(
      "--account-id",
      accountId,
      "--hbar-amount",
      hbarAmount,
      "--deployment",
      deployment,
      "--dev",
    );
    await safeExec("solo", updateArgs);

    safeInfo(`accountId=${accountId}`);
    safeInfo(`publicKey=${publicKey}`);
    safeInfo(`privateKey=${privateKey.trim()}`);

    // Set outputs based on account type
    if (type === "ecdsa") {
      safeSetOutput("ecdsaAccountId", accountId);
      safeSetOutput("ecdsaPublicKey", publicKey);
      safeSetOutput("ecdsaPrivateKey", privateKey.trim());
    } else {
      safeSetOutput("ed25519AccountId", accountId);
      safeSetOutput("ed25519PublicKey", publicKey);
      safeSetOutput("ed25519PrivateKey", privateKey.trim());

      // Set generic outputs for backward compatibility
      safeSetOutput("accountId", accountId);
      safeSetOutput("publicKey", publicKey);
      safeSetOutput("privateKey", privateKey.trim());
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create ${type} account: ${errorMessage}`);
  }
}

/**
 * Safely sets failed state with proper error handling
 */
function safeSetFailed(message: string): void {
  try {
    setFailed(message);
  } catch {
    console.error(`Failed to set failed state: ${message}`);
    process.exit(1);
  }
}

/**
 * Main entry point.
 * Installs dependencies, detects Solo version, deploys the test network,
 * optionally deploys Mirror Node and Relay, and creates accounts.
 */
async function run(): Promise<void> {
  try {
    // Phase 1: Install all dependencies
    await setupDependencies();

    // Phase 2: Detect Solo CLI version
    const soloGe0440 = await checkSoloVersion();

    // Phase 3: Deploy Solo test network
    await deploySoloTestNetwork(soloGe0440);

    // Phase 4: Deploy optional services
    await deployMirrorNode(soloGe0440);
    await deployRelay(soloGe0440);

    // Phase 5: Create accounts
    await createAccount("ecdsa", soloGe0440);
    await createAccount("ed25519", soloGe0440);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    safeSetFailed(`Script execution failed: ${errorMessage}`);
  }
}

// Execute the main function and handle any unhandled errors
run().catch((error) => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  safeSetFailed(`Unhandled error in main execution: ${errorMessage}`);
});
