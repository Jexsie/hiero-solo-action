import { soloRun, safeGetInput, safeInfo, runCommand, portForwardIfExists } from "./utils.js";
import type { SoloContext } from "./types.js";
import {
    DEFAULT_MIRROR_NODE_PORT_REST,
    DEFAULT_MIRROR_NODE_PORT_GRPC,
    DEFAULT_MIRROR_NODE_PORT_WEB3,
    DEFAULT_JAVA_REST_API_PORT,
    DEFAULT_RELAY_PORT,
    MIRROR_NODE_REST_INTERNAL_PORT,
    MIRROR_NODE_GRPC_INTERNAL_PORT,
    RELAY_INTERNAL_PORT,
} from "./constants.js";
import { join } from "path";
import { existsSync } from "fs";

/**
 * Deploys the Mirror Node.
 * Also runs when installRelay is true since the relay depends on
 * mirror-ingress-controller (--enable-ingress).
 */
export async function deployMirrorNode(ctx: SoloContext): Promise<void> {
    const installMirrorNode = safeGetInput("installMirrorNode") === "true";
    const installRelay = safeGetInput("installRelay") === "true";
    if (!installMirrorNode && !installRelay) return;

    const version = safeGetInput("mirrorNodeVersion");
    const portRest = safeGetInput("mirrorNodePortRest") || DEFAULT_MIRROR_NODE_PORT_REST;
    const portGrpc = safeGetInput("mirrorNodePortGrpc") || DEFAULT_MIRROR_NODE_PORT_GRPC;
    const portWeb3 = safeGetInput("mirrorNodePortWeb3Rest") || DEFAULT_MIRROR_NODE_PORT_WEB3;
    const javaRestApiPort = safeGetInput("javaRestApiPort") || DEFAULT_JAVA_REST_API_PORT;

    // Relay requires mirror-ingress-controller
    const enableIngress = installRelay;

    try {
        await soloRun(ctx.cmd.deployMirrorNode(ctx.clusterName, ctx.deployment, version, enableIngress));

        safeInfo(`Listing services in namespace ${ctx.namespace}:`);
        await runCommand(`kubectl get svc -n ${ctx.namespace}`);

        await portForwardIfExists("mirror-1-rest",     `${portRest}:${MIRROR_NODE_REST_INTERNAL_PORT}`, ctx.namespace);
        await portForwardIfExists("mirror-1-grpc",     `${portGrpc}:${MIRROR_NODE_GRPC_INTERNAL_PORT}`, ctx.namespace);
        await portForwardIfExists("mirror-1-web3",     `${portWeb3}:${MIRROR_NODE_REST_INTERNAL_PORT}`, ctx.namespace);
        await portForwardIfExists("mirror-1-restjava", `${javaRestApiPort}:${MIRROR_NODE_REST_INTERNAL_PORT}`, ctx.namespace);
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to deploy Mirror Node: ${msg}`, { cause: error });
    }
}

/**
 * Deploys the JSON-RPC Relay.
 */
export async function deployRelay(ctx: SoloContext): Promise<void> {
    if (safeGetInput("installRelay") !== "true") return;

    const relayPort = safeGetInput("relayPort") || DEFAULT_RELAY_PORT;

    try {
        const workspacePath = process.env.GITHUB_WORKSPACE ?? ".";
        const relayValuesFile = join(workspacePath, "relay-low-resources.yaml");
        const valuesFile = existsSync(relayValuesFile) ? relayValuesFile : undefined;

        await soloRun(ctx.cmd.deployRelay(ctx.deployment, valuesFile));
        safeInfo("JSON-RPC-Relay installed successfully");

        safeInfo(`Listing services in namespace ${ctx.namespace}:`);
        await runCommand(`kubectl get svc -n ${ctx.namespace}`);

        await portForwardIfExists(
            "relay-node1-hedera-json-rpc-relay",
            `${relayPort}:${RELAY_INTERNAL_PORT}`,
            ctx.namespace,
        );
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        safeInfo(`Relay deployment failed: ${msg}, continuing...`);
    }
}
