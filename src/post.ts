import { getState, warning, error as coreError } from "@actions/core";
import { runCommand, safeInfo } from "./utils.js";

/**
 * Cleanup function to delete the kind cluster
 */
async function cleanup(): Promise<void> {
  const clusterName = getState("clusterName");

  if (!clusterName) {
    safeInfo("[cleanup] No cluster name found in state, skipping cleanup");
    return;
  }

  safeInfo(`[cleanup] Starting cleanup for cluster: ${clusterName}`);

  try {
    await runCommand(`kind delete cluster --name ${clusterName}`);
    safeInfo(`[cleanup] Cluster '${clusterName}' deleted successfully`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warning(`[cleanup] Failed to delete cluster '${clusterName}': ${message}`);
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
