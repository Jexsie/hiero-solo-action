import { getInput, info, setOutput } from "@actions/core";
import { exec } from "@actions/exec";
import { spawn } from "child_process";
import { readFileSync } from "fs";

/**
 * Extracts the account information from the output text
 * @param inputText - The text to extract the account information from
 * @returns The account information as a JSON string
 */
export function extractAccountAsJson(inputText: string): string {
  const jsonRegex =
    /\{\s*"accountId":\s*".*?",\s*"publicKey":\s*".*?",\s*"balance":\s*\d+\s*\}/s;
  const match = inputText.match(jsonRegex);
  if (match) {
    return match[0];
  } else {
    throw new Error("No JSON block found in output");
  }
}

/**
 * Safely gets input with proper error handling
 * @param name - The input name to retrieve
 * @returns The input value or empty string if not found
 */
export function safeGetInput(name: string): string {
  try {
    return getInput(name) ?? "";
  } catch {
    return "";
  }
}

/**
 * Safely sets output with proper error handling
 * @param name - The output name to set
 * @param value - The value to set
 */
export function safeSetOutput(name: string, value: string): void {
  try {
    setOutput(name, value);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    info(`Failed to set output ${name}: ${errorMessage}`);
  }
}

/**
 * Safely logs info with proper error handling
 * @param message - The message to log
 */
export function safeInfo(message: string): void {
  try {
    info(message);
  } catch (error) {
    console.log(message); // Fallback to console.log if info fails
  }
}

/**
 * Executes a command safely with proper error handling
 * @param command - The command to execute
 * @param args - The arguments for the command
 * @param options - Optional execution options
 */
export async function safeExec(
  command: string,
  args?: string[],
  options?: Parameters<typeof exec>[2],
): Promise<number> {
  try {
    const result = await exec(command, args, options);
    return typeof result === "number" ? result : 0;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Command failed: ${command} ${args?.join(" ") ?? ""} - ${errorMessage}`,
    );
  }
}

/**
 * Port forwards a service if it exists
 * This port forwards a service if it exists in the namespace
 * @param service - The name of the service to port forward
 * @param portSpec - The port specification to use for the port forward
 * @param namespace - The namespace to port forward the service from
 */
export async function portForwardIfExists(
  service: string,
  portSpec: string,
  namespace: string,
): Promise<void> {
  try {
    // Check if service exists first
    const exitCode = await safeExec("kubectl", [
      "get",
      "svc",
      service,
      "-n",
      namespace,
    ]);

    if (exitCode === 0) {
      safeInfo(`Service ${service} exists`);

      const portForwardProcess = spawn(
        "kubectl",
        ["port-forward", `svc/${service}`, "-n", namespace, portSpec],
        {
          detached: true,
          stdio: "ignore",
        },
      );

      // Handle process errors
      portForwardProcess.on("error", (error) => {
        safeInfo(`Port-forward process error for ${service}: ${error.message}`);
      });

      portForwardProcess.unref();
      safeInfo(`Port-forward started for ${service} on ${portSpec}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    safeInfo(
      `Service ${service} not found or error occurred: ${errorMessage}, skipping port-forward`,
    );
  }
}

/**
 * Safely reads a file with proper error handling
 * @param filePath - The path to the file to read
 * @returns The file content as string
 */
export function safeReadFileSync(filePath: string): string {
  try {
    return readFileSync(filePath, "utf-8");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read file ${filePath}: ${errorMessage}`);
  }
}
