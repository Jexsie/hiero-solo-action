import {
    soloRun,
    runCommand,
    safeGetInput,
    safeInfo,
    safeSetOutput,
    safeReadFileSync,
    extractAccountAsJson,
} from "./utils.js";
import type { AccountInfo, SoloContext } from "./types.js";
import { DEFAULT_HBAR_AMOUNT } from "./constants.js";

/**
 * Creates an account (ECDSA or ED25519), updates its HBAR balance,
 * and writes the account details to action outputs.
 */
export async function createAccount(
    type: "ecdsa" | "ed25519",
    ctx: SoloContext,
): Promise<void> {
    const outputFile = `account_create_output_${type}.txt`;
    const hbarAmount = safeGetInput("hbarAmount") || DEFAULT_HBAR_AMOUNT;
    const isEcdsa = type === "ecdsa";

    safeInfo(`Creating ${type.toUpperCase()} account...`);

    try {
        // Create the account and capture output
        const createCmd = `${ctx.cmd.createAccount(ctx.deployment, isEcdsa)} > ${outputFile}`;
        await runCommand(`bash -c '${createCmd}'`);

        // Parse the account JSON from the CLI output
        const content = safeReadFileSync(outputFile);
        const accountJson = extractAccountAsJson(content);
        const { accountId, publicKey } = JSON.parse(accountJson) as AccountInfo;

        if (!accountId || !publicKey) {
            safeInfo("Account ID or public key not found, skipping account creation");
            return;
        }

        // Retrieve the private key from the Kubernetes secret
        const privateKeyCmd = `kubectl get secret account-key-${accountId} -n ${ctx.namespace} -o jsonpath='{.data.privateKey}' | base64 -d | xargs`;
        let privateKey = "";
        await runCommand(`bash -c "${privateKeyCmd}"`, {
            listeners: {
                stdout: (data: Buffer) => { privateKey += data.toString(); },
            },
        });

        // Fund the account
        await soloRun(ctx.cmd.updateAccount(accountId, hbarAmount, ctx.deployment));

        safeInfo(`accountId=${accountId}`);
        safeInfo(`publicKey=${publicKey}`);
        safeInfo(`privateKey=${privateKey.trim()}`);

        // Write type-specific outputs
        if (isEcdsa) {
            safeSetOutput("ecdsaAccountId",  accountId);
            safeSetOutput("ecdsaPublicKey",  publicKey);
            safeSetOutput("ecdsaPrivateKey", privateKey.trim());
        } else {
            safeSetOutput("ed25519AccountId",  accountId);
            safeSetOutput("ed25519PublicKey",  publicKey);
            safeSetOutput("ed25519PrivateKey", privateKey.trim());

            // Generic outputs for backward compatibility
            safeSetOutput("accountId",  accountId);
            safeSetOutput("publicKey",  publicKey);
            safeSetOutput("privateKey", privateKey.trim());
        }
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to create ${type} account: ${msg}`, { cause: error });
    }
}
