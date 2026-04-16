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
import {
  safeInfo,
  safeExec,
  safeGetInput,
  safeSetOutput,
  safeReadFileSync,
  portForwardIfExists,
  extractAccountAsJson,
} from "./utils";

interface AccountInfo {
  accountId: string;
  publicKey: string;
  balance: number;
}

async function setupDependencies() {
  startGroup("Installing System Dependencies");

  try {
    // 1. Install WGet & Python (Standard OS packages)
    safeInfo(
      "Updating apt and installing Wget, Python, Java 21, Kind, and Kubectl",
    );
    await exec("sudo apt-get update");
    await exec("sudo apt-get install -y wget python3.10");

    // 2. Setup Java 21 (Temurin)
    const javaPath = await which("java", false);
    if (!javaPath) {
      safeInfo("Installing OpenJDK 21...");
      await exec("sudo apt-get install -y openjdk-21-jdk");
    }

    // Setups Kind
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

    // Setups Kubectl (required by Kind)
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

    // Installs Solo CLI
    const soloVersion = getInput("soloVersion") || "latest";
    safeInfo(`Installing Solo CLI version: ${soloVersion}`);
    // We use --unsafe-perm if running as root in some containers,
    // but usually standard global install works on GH runners.
    await exec("sudo npm install -g @hashgraph/solo@" + soloVersion);

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
async function connectSoloToCluster(clusterName: string): Promise<void> {
  await safeExec("solo", [
    "cluster-ref",
    "connect",
    "--cluster-ref",
    `kind-${clusterName}`,
    "--context",
    `kind-${clusterName}`,
  ]);
}

/**
 * Creates a new Solo deployment
 */
async function createSoloDeployment(
  namespace: string,
  deployment: string,
): Promise<void> {
  await safeExec("solo", [
    "deployment",
    "create",
    "-n",
    namespace,
    "--deployment",
    deployment,
  ]);
}

/**
 * Adds cluster to deployment
 */
async function addClusterToDeployment(
  deployment: string,
  clusterName: string,
): Promise<void> {
  await safeExec("solo", [
    "deployment",
    "add-cluster",
    "--deployment",
    deployment,
    "--cluster-ref",
    `kind-${clusterName}`,
    "--num-consensus-nodes",
    "1",
  ]);
}

/**
 * Generates keys for the node
 */
async function generateNodeKeys(deployment: string): Promise<void> {
  await safeExec("solo", [
    "node",
    "keys",
    "--gossip-keys",
    "--tls-keys",
    "-i",
    "node1",
    "--deployment",
    deployment,
  ]);
}

/**
 * Sets up the Solo cluster
 */
async function setupSoloCluster(clusterName: string): Promise<void> {
  await safeExec("solo", ["cluster-ref", "setup", "-s", clusterName]);
}

/**
 * Deploys the network
 */
async function deployNetwork(deployment: string): Promise<void> {
  await safeExec("solo", [
    "network",
    "deploy",
    "-i",
    "node1",
    "--deployment",
    deployment,
  ]);
}

/**
 * Sets up the node
 */
async function setupNode(
  deployment: string,
  hieroVersion: string,
): Promise<void> {
  await safeExec("solo", [
    "node",
    "setup",
    "-i",
    "node1",
    "--deployment",
    deployment,
    "-t",
    hieroVersion,
    "--quiet-mode",
  ]);
}

/**
 * Starts the node
 */
async function startNode(deployment: string): Promise<void> {
  await safeExec("solo", [
    "node",
    "start",
    "-i",
    "node1",
    "--deployment",
    deployment,
  ]);
}

/**
 * Deploys a Solo test network
 * This creates a new Kubernetes cluster using kind, initializes the Solo CLI configuration,
 * connects the Solo CLI to the kind cluster, creates a new deployment, adds the kind cluster
 * to the deployment with 1 consensus node, generates keys for the node, sets up the Solo cluster,
 * deploys the network, sets up the node, and starts the node
 * @returns void
 */
async function deploySoloTestNetwork(): Promise<void> {
  const clusterName = "solo-e2e";
  const namespace = "solo";
  const deployment = "solo-deployment";
  const hieroVersion = safeGetInput("hieroVersion");

  if (!hieroVersion) {
    safeInfo("Hiero version not found, skipping deployment");
    return;
  }

  try {
    saveState("clusterName", clusterName);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to save cluster name state: ${errorMessage}`);
  }

  try {
    await createKindCluster(clusterName);
    await initializeSolo();
    await connectSoloToCluster(clusterName);
    await createSoloDeployment(namespace, deployment);
    await addClusterToDeployment(deployment, clusterName);
    await generateNodeKeys(deployment);
    await setupSoloCluster(clusterName);
    await deployNetwork(deployment);
    await setupNode(deployment, hieroVersion);
    await startNode(deployment);

    // Debug: List services in the solo namespace
    await safeExec("kubectl", ["get", "svc", "-n", namespace]);

    // Port forward the HAProxy service
    await portForwardIfExists("haproxy-node1-svc", "50211:50211", namespace);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to deploy Solo test network: ${errorMessage}`);
  }
}

/**
 * Deploys a Mirror Node
 * This deploys a Mirror Node in the Solo cluster.
 * @returns void
 */
async function deployMirrorNode(): Promise<void> {
  const installMirrorNode = safeGetInput("installMirrorNode") === "true";
  if (!installMirrorNode) return;

  const namespace = "solo";
  const deployment = "solo-deployment";
  const version = safeGetInput("mirrorNodeVersion");
  const portRest = safeGetInput("mirrorNodePortRest");
  const portGrpc = safeGetInput("mirrorNodePortGrpc");
  const portWeb3 = safeGetInput("mirrorNodePortWeb3Rest");

  try {
    // Deploy the Mirror Node
    await safeExec("solo", [
      "mirror-node",
      "deploy",
      "--deployment",
      deployment,
      "--mirror-node-version",
      version,
    ]);

    // List services in the solo namespace
    await safeExec("kubectl", ["get", "svc", "-n", namespace]);

    // Port forward the Mirror Node services
    await portForwardIfExists("mirror-rest", `${portRest}:80`, namespace);
    await portForwardIfExists("mirror-grpc", `${portGrpc}:5600`, namespace);
    await portForwardIfExists("mirror-web3", `${portWeb3}:80`, namespace);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to deploy Mirror Node: ${errorMessage}`);
  }
}

/**
 * Deploys a Relay
 * This deploys a Relay in the Solo cluster
 * @returns void
 */
async function deployRelay(): Promise<void> {
  const installRelay = safeGetInput("installRelay") === "true";
  if (!installRelay) return;

  const namespace = "solo";
  const deployment = "solo-deployment";
  const relayPort = safeGetInput("relayPort");

  try {
    // Deploy the Relay
    await safeExec("solo", [
      "relay",
      "deploy",
      "-i",
      "node1",
      "--deployment",
      deployment,
    ]);

    // List services in the solo namespace
    await safeExec("kubectl", ["get", "svc", "-n", namespace]);

    // Port forward the Relay service
    await portForwardIfExists(
      "relay-node1-hedera-json-rpc-relay",
      `${relayPort}:7546`,
      namespace,
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    safeInfo(`Relay service deployment failed: ${errorMessage}, continuing...`);
  }
}

/**
 * Creates an account
 * This creates an account in the Solo cluster
 * @param type - The type of account to create (ecdsa or ed25519)
 * @returns void
 */
async function createAccount(type: "ecdsa" | "ed25519"): Promise<void> {
  const namespace = "solo";
  const deployment = "solo-deployment";
  const outputFile = `account_create_output_${type}.txt`;
  const generateFlag = type === "ecdsa" ? "--generate-ecdsa-key" : "";

  try {
    // Create an account
    const createCommand = `solo account create ${generateFlag} --deployment "${deployment}" > ${outputFile}`;
    await safeExec("bash", ["-c", createCommand]);

    const extractAccountJson = (): string => {
      try {
        const content = safeReadFileSync(outputFile);
        return extractAccountAsJson(content);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to read or parse account file: ${errorMessage}`,
        );
      }
    };

    const accountJson = extractAccountJson();
    const accountInfo = JSON.parse(accountJson) as AccountInfo;
    const { accountId, publicKey } = accountInfo;

    if (!accountId || !publicKey) {
      safeInfo("Account ID or public key not found, skipping account creation");
      return;
    }

    const privateKeyCmd = `kubectl get secret account-key-${accountId} -n ${namespace} -o jsonpath='{.data.privateKey}' | base64 -d | xargs`;
    let privateKey = "";

    // Get the private key
    await safeExec("bash", ["-c", privateKeyCmd], {
      listeners: {
        stdout: (data: Buffer) => {
          privateKey += data.toString();
        },
      },
    });

    // Update the account
    await safeExec("solo", [
      "account",
      "update",
      "--account-id",
      accountId,
      "--hbar-amount",
      "10000000",
      "--deployment",
      deployment,
    ]);

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
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create ${type} account: ${errorMessage}`);
  }
}

/**
 * Safely sets failed state with proper error handling
 * @param message - The error message to set
 */
function safeSetFailed(message: string): void {
  try {
    setFailed(message);
  } catch (error) {
    console.error(`Failed to set failed state: ${message}`);
    process.exit(1);
  }
}

/**
 * Runs the script
 * This runs the script to deploy the Solo test network, Mirror Node, Relay, and create an account
 * @returns void
 */
async function run(): Promise<void> {
  try {
    await setupDependencies();
    await deploySoloTestNetwork();
    await deployMirrorNode();
    await deployRelay();
    await createAccount("ecdsa");
    await createAccount("ed25519");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    safeSetFailed(`Script execution failed: ${errorMessage}`);
  }
}

// Execute the main function and handle any unhandled errors
run().catch((error) => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  safeSetFailed(`Unhandled error in main execution: ${errorMessage}`);
});
