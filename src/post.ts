import { getState, warning, error as coreError } from "@actions/core";
import { runCommand, safeInfo } from "./utils.js";
import { homedir } from "os";
import { join } from "path";
import { rmSync } from "fs";

/**
 * Cleanup function to delete the kind cluster and Solo state.
 *
 * On self-hosted runners all jobs share the same machine, so we must
 * remove every piece of state that would cause the next run to fail
 * (e.g. "A deployment named solo-deployment already exists").
 */
async function cleanup(): Promise<void> {
    const clusterName = getState("clusterName");

    if (!clusterName) {
        safeInfo("[cleanup] No cluster name found in state, skipping cleanup");
        return;
    }

    safeInfo(`[cleanup] Starting cleanup for cluster: ${clusterName}`);

    // Deletes the kind cluster
    try {
        await runCommand(`kind delete cluster --name ${clusterName}`);
        safeInfo(`[cleanup] Cluster '${clusterName}' deleted successfully`);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        warning(
            `[cleanup] Failed to delete cluster '${clusterName}': ${message}`,
        );
    }

    // Remove Solo's local config directory so the next job starts fresh
    const soloConfigDir = join(homedir(), ".solo");
    try {
        rmSync(soloConfigDir, { recursive: true, force: true });
        safeInfo(`[cleanup] Removed Solo config directory: ${soloConfigDir}`);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        warning(`[cleanup] Failed to remove Solo config directory: ${message}`);
    }

    // Prune leftover Docker resources (containers, networks, volumes)
    try {
        await runCommand("docker system prune -af --volumes", {
            ignoreReturnCode: true,
        });
        safeInfo("[cleanup] Docker resources pruned successfully");
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        warning(`[cleanup] Failed to prune Docker resources: ${message}`);
    }
}

async function main(): Promise<void> {
    try {
        await cleanup();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        warning(`[main] Cleanup threw an error: ${message}`);
    }
}

main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    coreError(`[main] Unhandled error: ${message}`);
    process.exitCode = 1;
});
