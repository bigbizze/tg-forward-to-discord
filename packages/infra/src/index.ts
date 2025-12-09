import * as fs from "node:fs";
import path from "node:path";
import { default as appRootPath } from "app-root-path";
import dotenv from "dotenv";

const dotEnvPath = path.resolve("..", "..", appRootPath.path, ".env");

dotenv.config({
  path: dotEnvPath,
  override: true
});

import * as pulumi from "@pulumi/pulumi";
import * as hcloud from "@pulumi/hcloud";
import * as tls from "@pulumi/tls";
import { Output } from "@pulumi/pulumi/output";
import type { ID } from "@pulumi/pulumi/resource";

// Read Hetzner token from environment or Pulumi config
const config = new pulumi.Config("hcloud");
const token = process.env.HCLOUD_TOKEN || config.require("token");

const PROJECT_NAME = "tg-discord-bridge";

// =============================================================================
// SSH Key Generation
// =============================================================================

const sshKey = new tls.PrivateKey(`${PROJECT_NAME}-ssh-key`, {
  algorithm: "ED25519"
});

const hcloudSshKey = new hcloud.SshKey(`${PROJECT_NAME}-key`, {
  name: `${PROJECT_NAME}-deploy-key`,
  publicKey: sshKey.publicKeyOpenssh
});

// =============================================================================
// Firewall (Optional: Restrict SSH to GitHub Actions IPs)
// =============================================================================

// GitHub Actions IP ranges from api.github.com/meta
const GITHUB_ACTIONS_IPS = [
  // Just the main ranges to keep it manageable
  "4.148.0.0/16",
  "4.149.0.0/18",
  "4.151.0.0/16",
  "4.152.0.0/15",
  "20.20.0.0/16",
  "20.29.0.0/17",
  "20.51.0.0/16",
  // Add more from the response if needed
  "0.0.0.0/0",  // Allow all for now (remove this line to restrict)
  "::/0"
];

const firewall = new hcloud.Firewall(`${PROJECT_NAME}-firewall`, {
  name: `${PROJECT_NAME}-firewall`,
  rules: [
    // SSH - restricted to GitHub Actions or everywhere
    {
      direction: "in",
      protocol: "tcp",
      port: "22",
      sourceIps: GITHUB_ACTIONS_IPS
    },
    // Allow all outbound for API calls
    {
      direction: "out",
      protocol: "tcp",
      port: "any",
      destinationIps: [ "0.0.0.0/0", "::/0" ]
    },
    {
      direction: "out",
      protocol: "udp",
      port: "any",
      destinationIps: [ "0.0.0.0/0", "::/0" ]
    }
  ]
});

// =============================================================================
// Server (Hardcoded Configuration)
// =============================================================================

const cloudInitConfig = fs.readFileSync("./cloud-init.yaml", "utf8");

const server = new hcloud.Server(`${PROJECT_NAME}-server`, {
  name: PROJECT_NAME,
  serverType: "cx22",           // Hardcoded: 2 vCPU, 4 GB RAM
  image: "ubuntu-22.04",         // Hardcoded: Ubuntu 22.04
  location: "hel1",              // Hardcoded: Helsinki
  sshKeys: [ hcloudSshKey.id ],

  publicNets: [ {
    ipv4Enabled: true,
    ipv6Enabled: true
  } ],

  firewallIds: [ firewall.id ].map((id: Output<ID> | string | number) => {
    if (typeof id === "string") {
      return parseInt(id, 10);
    } else if (typeof id === "number") {
      return id;
    } else {
      return id.apply(i => parseInt(i, 10));
    }
  }),
  userData: cloudInitConfig,
  labels: {
    app: "tg-discord-bridge",
    environment: "production",
    managed_by: "pulumi"
  }
});

// =============================================================================
// Outputs (For GitHub Secrets)
// =============================================================================

export const serverIp = server.ipv4Address;
export const sshPrivateKey = pulumi.secret(sshKey.privateKeyOpenssh);
export const sshPublicKey = sshKey.publicKeyOpenssh;

// Helper commands (shown in terminal after deployment)
export const setupInstructions = pulumi.interpolate`
=============================================================================
GITHUB ACTIONS SETUP INSTRUCTIONS
=============================================================================

1. Get the server IP:
   pulumi stack output serverIp

2. Get the SSH private key:
   pulumi stack output sshPrivateKey --show-secrets

3. In GitHub, go to: Settings → Secrets and variables → Actions

4. Add these secrets:
   - SSH_HOST: (paste the IP from step 1)
   - SSH_PRIVATE_KEY: (paste the ENTIRE key from step 2, including BEGIN/END lines)

5. Your GitHub Actions workflow is ready to deploy!

=============================================================================
`;