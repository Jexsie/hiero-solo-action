export const PYTHON_VERSION = "3.12.9";
export const PYTHON_RELEASE_TAG = "20250409";
export const PYTHON_DOWNLOAD_URL = `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE_TAG}/cpython-${PYTHON_VERSION}%2B${PYTHON_RELEASE_TAG}-x86_64-unknown-linux-gnu-install_only.tar.gz`;

export const WGET_VERSION = "1.25.0";
export const WGET_DOWNLOAD_URL =
    "https://github.com/userdocs/qbt-workflow-files/releases/latest/download/wget";

export const JAVA_VERSION = "21.0.6";
export const JAVA_DOWNLOAD_URL =
    "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse?project=jdk";

export const KIND_VERSION = "v0.29.0";
export const KIND_DOWNLOAD_URL = `https://kind.sigs.k8s.io/dl/${KIND_VERSION}/kind-linux-amd64`;

export const KUBECTL_VERSION = "v1.32.2";
export const KUBECTL_DOWNLOAD_URL = `https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl`;

export const NODE_VERSION = "24.0.1";
export const NODE_DOWNLOAD_URL = `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz`;
