import { saveState } from "@actions/core";
import { setupDependencies, checkSoloVersion } from "./setup.js";
import {
    soloRun,
    runCommand,
    safeGetInput,
    safeSetOutput,
    safeReadFileSync,
    portForwardIfExists,
    extractAccountAsJson,
    safeInfo,
    safeSetFailed,
} from "./utils.js";
import {
    CLUSTER_NAME,
    NAMESPACE,
    DEPLOYMENT_NAME,
    DEFAULT_HAPROXY_PORT,
    DEFAULT_GRPC_PROXY_PORT,
    DEFAULT_DUAL_MODE_GRPC_PROXY_PORT,
    DEFAULT_MIRROR_NODE_PORT_REST,
    DEFAULT_MIRROR_NODE_PORT_GRPC,
    DEFAULT_MIRROR_NODE_PORT_WEB3,
    DEFAULT_JAVA_REST_API_PORT,
    DEFAULT_RELAY_PORT,
    DEFAULT_HBAR_AMOUNT,
    HAPROXY_INTERNAL_PORT,
    HAPROXY_NODE2_EXTERNAL_PORT,
    GRPC_PROXY_INTERNAL_PORT,
    MIRROR_NODE_REST_INTERNAL_PORT,
    MIRROR_NODE_GRPC_INTERNAL_PORT,
    RELAY_INTERNAL_PORT,
} from "./constants.js";
import { join } from "path";
import { existsSync } from "fs";

interface AccountInfo {
    accountId: string;
    publicKey: string;
    balance: number;
}

// ---------------------------------------------------------------------------
// Solo CLI Helper Functions
// ---------------------------------------------------------------------------

/**
 * Creates a Kubernetes cluster using kind
 */
async function createKindCluster(clusterName: string): Promise<void> {
    await runCommand(`kind create cluster -n ${clusterName}`);
}

/**
 * Initializes Solo CLI configuration
 */
async function initializeSolo(): Promise<void> {
    await soloRun("solo init --dev");
}

/**
 * Connects Solo CLI to the kind cluster
 */
async function connectSoloToCluster(
    clusterName: string,
    soloGe0440: boolean,
): Promise<void> {
    if (soloGe0440) {
        await soloRun(
            `solo cluster-ref config connect --cluster-ref kind-${clusterName} --context kind-${clusterName} --dev`,
        );
    } else {
        await soloRun(
            `solo cluster-ref connect --cluster-ref kind-${clusterName} --context kind-${clusterName} --dev`,
        );
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
        await soloRun(
            `solo deployment config create -n ${namespace} --deployment ${deployment} --dev`,
        );
    } else {
        await soloRun(
            `solo deployment create -n ${namespace} --deployment ${deployment} --dev`,
        );
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
        await soloRun(
            `solo deployment cluster attach --deployment ${deployment} --cluster-ref kind-${clusterName} --num-consensus-nodes ${numNodes} --dev`,
        );
    } else {
        await soloRun(
            `solo deployment add-cluster --deployment ${deployment} --cluster-ref kind-${clusterName} --num-consensus-nodes ${numNodes} --dev`,
        );
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
        await soloRun(
            `solo keys consensus generate --gossip-keys --tls-keys -i ${nodeIds} --deployment ${deployment} --dev`,
        );
    } else {
        await soloRun(
            `solo node keys --gossip-keys --tls-keys -i ${nodeIds} --deployment ${deployment} --dev`,
        );
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
        await soloRun(`solo cluster-ref config setup -s ${clusterName} --dev`);
    } else {
        await soloRun(`solo cluster-ref setup -s ${clusterName} --dev`);
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
        await soloRun(
            `solo consensus network deploy -i ${nodeIds} --deployment ${deployment} --release-tag ${hieroVersion} --dev`,
        );
    } else {
        await soloRun(
            `solo network deploy -i ${nodeIds} --deployment ${deployment} --release-tag ${hieroVersion} --dev`,
        );
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
        await soloRun(
            `solo consensus node setup -i ${nodeIds} --deployment ${deployment} --release-tag ${hieroVersion} --quiet-mode --dev`,
        );
    } else {
        await soloRun(
            `solo node setup -i ${nodeIds} --deployment ${deployment} --release-tag ${hieroVersion} --quiet-mode --dev`,
        );
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
        await soloRun(
            `solo consensus node start -i ${nodeIds} --deployment ${deployment} --dev`,
        );
    } else {
        await soloRun(
            `solo node start -i ${nodeIds} --deployment ${deployment} --dev`,
        );
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
        const sudoCheck = await runCommand("sudo -n true", {
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
                await runCommand(
                    `bash -c 'echo "${entry}" | sudo tee -a /etc/hosts'`,
                );
            }
            safeInfo("Successfully added entries to /etc/hosts");
        } else {
            safeInfo(
                "⚠️  No sudo access available, skipping /etc/hosts update. Nodes can still be accessed via localhost.",
            );
        }
    } catch (error: unknown) {
        const errorMessage =
            error instanceof Error ? error.message : String(error);
        safeInfo(
            `⚠️  Failed to update /etc/hosts: ${errorMessage}, continuing...`,
        );
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
    const hieroVersion = safeGetInput("hieroVersion");
    const dualMode = safeGetInput("dualMode") === "true";
    const haproxyPort = safeGetInput("haproxyPort") || DEFAULT_HAPROXY_PORT;
    const grpcProxyPort =
        safeGetInput("grpcProxyPort") || DEFAULT_GRPC_PROXY_PORT;
    const dualModeGrpcProxyPort =
        safeGetInput("dualModeGrpcProxyPort") ||
        DEFAULT_DUAL_MODE_GRPC_PROXY_PORT;

    if (!hieroVersion) {
        safeInfo("Hiero version not found, skipping deployment");
        return;
    }

    const numNodes = dualMode ? 2 : 1;
    const nodeIds = dualMode ? "node1,node2" : "node1";

    safeInfo(
        `[deploySoloTestNetwork] soloGe0440=${soloGe0440}, dualMode=${dualMode}, nodes=${numNodes}, nodeIds=${nodeIds}, hieroVersion=${hieroVersion}, cluster=${CLUSTER_NAME}`,
    );

    try {
        saveState("clusterName", CLUSTER_NAME);
    } catch (error: unknown) {
        const errorMessage =
            error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to save cluster name state: ${errorMessage}`, {
            cause: error,
        });
    }

    try {
        await createKindCluster(CLUSTER_NAME);
        await initializeSolo();
        await connectSoloToCluster(CLUSTER_NAME, soloGe0440);
        await createSoloDeployment(NAMESPACE, DEPLOYMENT_NAME, soloGe0440);
        await addClusterToDeployment(
            DEPLOYMENT_NAME,
            CLUSTER_NAME,
            numNodes,
            soloGe0440,
        );
        await generateNodeKeys(DEPLOYMENT_NAME, nodeIds, soloGe0440);
        await setupSoloCluster(CLUSTER_NAME, soloGe0440);
        await deployNetwork(DEPLOYMENT_NAME, nodeIds, hieroVersion, soloGe0440);
        await setupNode(DEPLOYMENT_NAME, nodeIds, hieroVersion, soloGe0440);
        await startNode(DEPLOYMENT_NAME, nodeIds, soloGe0440);

        // Debug: List services in the solo namespace
        safeInfo(`Listing services in namespace ${NAMESPACE}:`);
        await runCommand(`kubectl get svc -n ${NAMESPACE}`);

        // Add /etc/hosts entries
        await setupHostsEntries(NAMESPACE, dualMode);

        // Port forward HAProxy for node1
        await portForwardIfExists(
            "haproxy-node1-svc",
            `${haproxyPort}:${HAPROXY_INTERNAL_PORT}`,
            NAMESPACE,
        );

        // Port forwards for node2 if dual mode is enabled
        if (dualMode) {
            await portForwardIfExists(
                "haproxy-node2-svc",
                `${HAPROXY_NODE2_EXTERNAL_PORT}:${HAPROXY_INTERNAL_PORT}`,
                NAMESPACE,
            );
            safeInfo(
                `HAProxy for node2 is accessible on port ${HAPROXY_NODE2_EXTERNAL_PORT}`,
            );

            await portForwardIfExists(
                "envoy-proxy-node2-svc",
                `${dualModeGrpcProxyPort}:${GRPC_PROXY_INTERNAL_PORT}`,
                NAMESPACE,
            );
            safeInfo(
                `gRPC proxy for node2 is accessible on port ${dualModeGrpcProxyPort}`,
            );
        }

        // Port forward gRPC proxy for node1
        await portForwardIfExists(
            "envoy-proxy-node1-svc",
            `${grpcProxyPort}:${GRPC_PROXY_INTERNAL_PORT}`,
            NAMESPACE,
        );
    } catch (error: unknown) {
        const errorMessage =
            error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to deploy Solo test network: ${errorMessage}`, {
            cause: error,
        });
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

    const version = safeGetInput("mirrorNodeVersion");
    const portRest =
        safeGetInput("mirrorNodePortRest") || DEFAULT_MIRROR_NODE_PORT_REST;
    const portGrpc =
        safeGetInput("mirrorNodePortGrpc") || DEFAULT_MIRROR_NODE_PORT_GRPC;
    const portWeb3 =
        safeGetInput("mirrorNodePortWeb3Rest") || DEFAULT_MIRROR_NODE_PORT_WEB3;
    const javaRestApiPort =
        safeGetInput("javaRestApiPort") || DEFAULT_JAVA_REST_API_PORT;

    // Relay requires mirror-ingress-controller; --enable-ingress installs it.
    const enableIngress = installRelay;

    try {
        let baseArgs = "";

        if (soloGe0440) {
            baseArgs = `solo mirror node add --cluster-ref kind-${CLUSTER_NAME} --deployment ${DEPLOYMENT_NAME} --mirror-node-version ${version} --pinger`;
        } else {
            baseArgs = `solo mirror-node deploy --cluster-ref kind-${CLUSTER_NAME} --deployment ${DEPLOYMENT_NAME} --mirror-node-version ${version} --pinger`;
        }

        if (enableIngress) {
            baseArgs += " --enable-ingress";
        }

        baseArgs += " --dev";

        await soloRun(baseArgs);

        // Debug: List services in the solo namespace
        safeInfo(`Listing services in namespace ${NAMESPACE}:`);
        await runCommand(`kubectl get svc -n ${NAMESPACE}`);

        // Port forward Mirror Node services
        await portForwardIfExists(
            "mirror-1-rest",
            `${portRest}:${MIRROR_NODE_REST_INTERNAL_PORT}`,
            NAMESPACE,
        );
        await portForwardIfExists(
            "mirror-1-grpc",
            `${portGrpc}:${MIRROR_NODE_GRPC_INTERNAL_PORT}`,
            NAMESPACE,
        );
        await portForwardIfExists(
            "mirror-1-web3",
            `${portWeb3}:${MIRROR_NODE_REST_INTERNAL_PORT}`,
            NAMESPACE,
        );
        await portForwardIfExists(
            "mirror-1-restjava",
            `${javaRestApiPort}:${MIRROR_NODE_REST_INTERNAL_PORT}`,
            NAMESPACE,
        );
    } catch (error: unknown) {
        const errorMessage =
            error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to deploy Mirror Node: ${errorMessage}`, {
            cause: error,
        });
    }
}

/**
 * Deploys the JSON-RPC Relay.
 */
async function deployRelay(soloGe0440: boolean): Promise<void> {
    const installRelay = safeGetInput("installRelay") === "true";
    if (!installRelay) return;

    const relayPort = safeGetInput("relayPort") || DEFAULT_RELAY_PORT;

    try {
        let baseArgs = "";

        if (soloGe0440) {
            baseArgs = `solo relay node add -i node1 --deployment ${DEPLOYMENT_NAME} --dev`;
        } else {
            baseArgs = `solo relay deploy -i node1 --deployment ${DEPLOYMENT_NAME} --dev`;
        }

        // Add --values-file if relay-low-resources.yaml exists
        const workspacePath = process.env.GITHUB_WORKSPACE ?? ".";
        const relayValuesFile = join(workspacePath, "relay-low-resources.yaml");
        if (existsSync(relayValuesFile)) {
            baseArgs += ` --values-file ${relayValuesFile}`;
        }

        await soloRun(baseArgs);
        safeInfo("JSON-RPC-Relay installed successfully");

        // Debug: List services in the solo namespace
        safeInfo(`Listing services in namespace ${NAMESPACE}:`);
        await runCommand(`kubectl get svc -n ${NAMESPACE}`);

        // Port forward the Relay service
        await portForwardIfExists(
            "relay-node1-hedera-json-rpc-relay",
            `${relayPort}:${RELAY_INTERNAL_PORT}`,
            NAMESPACE,
        );
    } catch (error: unknown) {
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
    const outputFile = `account_create_output_${type}.txt`;
    const hbarAmount = safeGetInput("hbarAmount") || DEFAULT_HBAR_AMOUNT;

    safeInfo(`Creating ${type.toUpperCase()} account...`);

    try {
        // Build the create command
        let createArgs = "";
        if (soloGe0440) {
            createArgs = `solo ledger account create`;
        } else {
            createArgs = `solo account create`;
        }

        if (type === "ecdsa") {
            createArgs += " --generate-ecdsa-key";
        }

        createArgs += ` --deployment ${DEPLOYMENT_NAME} --dev`;

        // Execute and redirect output to file
        const createCommand = `${createArgs} > ${outputFile}`;
        await runCommand(`bash -c '${createCommand}'`);

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
        const privateKeyCmd = `kubectl get secret account-key-${accountId} -n ${NAMESPACE} -o jsonpath='{.data.privateKey}' | base64 -d | xargs`;
        let privateKey = "";
        await runCommand(`bash -c "${privateKeyCmd}"`, {
            listeners: {
                stdout: (data: Buffer) => {
                    privateKey += data.toString();
                },
            },
        });

        // Update the account with the specified hbar amount
        let updateArgs = "";
        if (soloGe0440) {
            updateArgs = "solo ledger account update";
        } else {
            updateArgs = "solo account update";
        }
        updateArgs += ` --account-id ${accountId} --hbar-amount ${hbarAmount} --deployment ${DEPLOYMENT_NAME} --dev`;
        await soloRun(updateArgs);

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
    } catch (error: unknown) {
        const errorMessage =
            error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to create ${type} account: ${errorMessage}`, {
            cause: error,
        });
    }
}

/**
 * Main entry point.
 * Installs dependencies, detects Solo version, deploys the test network,
 * optionally deploys Mirror Node and Relay, and creates accounts.
 */
async function run(): Promise<void> {
    try {
        // Install all dependencies
        await setupDependencies();

        // Detect Solo CLI version
        const soloGe0440 = await checkSoloVersion();

        // Deploy Solo test network
        await deploySoloTestNetwork(soloGe0440);

        // Deploy optional services
        await deployMirrorNode(soloGe0440);
        await deployRelay(soloGe0440);

        // Create accounts
        await createAccount("ecdsa", soloGe0440);
        await createAccount("ed25519", soloGe0440);
    } catch (error: unknown) {
        const errorMessage =
            error instanceof Error ? error.message : String(error);
        safeSetFailed(`Script execution failed: ${errorMessage}`);
    }
}

// Execute the main function and handle any unhandled errors
run().catch((error: unknown) => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    safeSetFailed(`Unhandled error in main execution: ${errorMessage}`);
});
