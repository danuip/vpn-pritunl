import { EC2Client, CreateVpcCommand, ModifyVpcAttributeCommand, DescribeAvailabilityZonesCommand,
  CreateSubnetCommand, ModifySubnetAttributeCommand, CreateInternetGatewayCommand, AttachInternetGatewayCommand,
  CreateRouteTableCommand, CreateRouteCommand, AssociateRouteTableCommand, CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand, DescribeImagesCommand, RunInstancesCommand, DescribeInstancesCommand,
  GetConsoleOutputCommand } from "https://esm.sh/@aws-sdk/client-ec2@3?bundle";
import { SSMClient, GetParameterCommand } from "https://esm.sh/@aws-sdk/client-ssm@3?bundle";
import { STSClient, GetCallerIdentityCommand } from "https://esm.sh/@aws-sdk/client-sts@3?bundle";
import { IAMClient, CreateRoleCommand, PutRolePolicyCommand, CreateInstanceProfileCommand,
  AddRoleToInstanceProfileCommand, GetInstanceProfileCommand } from "https://esm.sh/@aws-sdk/client-iam@3?bundle";

const REGION = "us-east-1";
// Amazon Linux 2023 x86_64, resolved via the public SSM parameter AWS maintains.
const AMI_PARAM = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64";

// The instance uses this role/profile to tag ITSELF with its deploy status,
// password and IP. Reusable across runs (created once, reused if it exists).
const ROLE_NAME = "pritunl-sandbox-self-tag";
const INSTANCE_PROFILE_NAME = "pritunl-sandbox-self-tag";

const STEPS = [
  ["validate", "Validating AWS credentials"],
  ["vpc", "Creating VPC"],
  ["igw", "Creating Internet Gateway"],
  ["subnet", "Creating subnet"],
  ["routes", "Creating route table"],
  ["sg", "Creating Security Group"],
  ["iam", "Creating instance role (self-tagging)"],
  ["ami", "Finding Amazon Linux 2023 AMI"],
  ["ec2", "Launching EC2 instance"],
  ["boot", "Waiting for instance to boot"],
  ["install", "Installing MongoDB & Pritunl on the instance"],
  ["configure", "Finalizing admin credentials"],
  ["ready", "Pritunl ready"],
];

const progressList = document.getElementById("progressList");
const els = {
  form: document.getElementById("panel-form"),
  progressPanel: document.getElementById("panel-progress"),
  resultPanel: document.getElementById("panel-result"),
  deployBtn: document.getElementById("deployBtn"),
  formError: document.getElementById("formError"),
  instanceBox: document.getElementById("instanceBox"),
  instanceId: document.getElementById("instanceId"),
  publicIp: document.getElementById("publicIp"),
  waitNote: document.getElementById("waitNote"),
  refreshBtn: document.getElementById("refreshBtn"),
  toggleLogBtn: document.getElementById("toggleLogBtn"),
  rawLog: document.getElementById("rawLog"),
  resPublicIp: document.getElementById("resPublicIp"),
  resUrl: document.getElementById("resUrl"),
  credsBox: document.getElementById("credsBox"),
  resUser: document.getElementById("resUser"),
  resPass: document.getElementById("resPass"),
  openBtn: document.getElementById("openBtn"),
};

function buildProgressUI() {
  progressList.innerHTML = "";
  for (const [id, label] of STEPS) {
    const li = document.createElement("li");
    li.id = `step-${id}`;
    li.innerHTML = `<span class="dot"></span><span>${label}</span>`;
    progressList.appendChild(li);
  }
}

function setStep(id, state, extraText) {
  const li = document.getElementById(`step-${id}`);
  if (!li) return;
  li.classList.remove("done", "active", "error");
  li.classList.add(state);
  if (extraText) {
    const span = li.querySelector("span:last-child");
    span.textContent = `${STEPS.find(s => s[0] === id)[1]} — ${extraText}`;
  }
}

function fail(id, err) {
  console.error(err);
  setStep(id, "error", err.message || String(err));
  els.formError.textContent = `Deployment stopped: ${err.message || err}`;
  els.formError.classList.remove("hidden");
  els.deployBtn.disabled = false;
}

// --- The EC2 user-data script. Fully self-contained; no values are injected
// from the browser. Everything Pritunl-specific (org name, server name,
// ports) is generated on the instance itself. ---
const USER_DATA = String.raw`#!/bin/bash
exec > >(tee -a /var/log/pritunl-deploy.log | logger -t pritunl-deploy -s 2>/dev/console) 2>&1
set -x

# Tag this instance with a status the browser can poll. Reliable + instant,
# unlike console output. Called on both success and failure paths.
# Usage: tag_status <status> [error]
tag_status() {
  local TOK IID AZ RGN
  TOK=$(curl -s -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 300')
  IID=$(curl -s -H "X-aws-ec2-metadata-token: $TOK" http://169.254.169.254/latest/meta-data/instance-id)
  AZ=$(curl -s -H "X-aws-ec2-metadata-token: $TOK" http://169.254.169.254/latest/meta-data/placement/availability-zone)
  RGN=$(echo "$AZ" | sed -E 's/[a-z]$//')
  aws ec2 create-tags --region "$RGN" --resources "$IID" --tags \
    "Key=PritunlStatus,Value=$1" "Key=PritunlError,Value=\${2:-}" >/dev/null 2>&1 || true
}

echo "STEP:Installing MongoDB..."

# Amazon Linux 2023 install, based on the official Pritunl documentation:
# https://docs.pritunl.com/kb/vpn/getting-started/installation
# Pritunl publishes dedicated amazonlinux builds. We deviate from the docs on
# one point: MongoDB is pinned to 7.0 instead of 8.0. MongoDB 8.0+ bundles a
# TCMalloc that refuses to start on Linux kernels 6.19-7.0.13 (SERVER-121912).
# The AL2023 default AMI now tracks the latest kernel (currently ~6.18) and is
# trending upward, so 8.0 is one kernel bump away from breaking. 7.0 has no
# such guard and is supported by Pritunl, so it stays reliable regardless of
# which kernel the AMI resolves to.

# Basic tooling used later in the script.
dnf -y install curl jq openssl python3 || true

tee /etc/yum.repos.d/mongodb-org.repo << 'REPOEOF'
[mongodb-org]
name=MongoDB Repository
baseurl=https://repo.mongodb.org/yum/amazon/2023/mongodb-org/7.0/x86_64/
gpgcheck=1
enabled=1
gpgkey=https://pgp.mongodb.com/server-7.0.asc
REPOEOF

tee /etc/yum.repos.d/pritunl.repo << 'REPOEOF'
[pritunl]
name=Pritunl Repository
baseurl=https://repo.pritunl.com/stable/yum/amazonlinux/2023/
gpgcheck=1
enabled=1
gpgkey=https://raw.githubusercontent.com/pritunl/pgp/master/pritunl_repo_pub.asc
REPOEOF

# Retry the metadata refresh -- cloud-init can run before networking/DNS is
# fully settled, and the mongo/pritunl repos are remote.
for i in $(seq 1 30); do
  if dnf -y makecache; then break; fi
  sleep 5
done

dnf -y install mongodb-org mongodb-mongosh

# Verify MongoDB actually installed. If the repo/key step failed, the package
# won't exist and "mongod.service not found" is the symptom -- catch it here
# with a clear message instead of failing cryptically later.
if [ ! -f /lib/systemd/system/mongod.service ] && [ ! -f /etc/systemd/system/mongod.service ]; then
  echo "STEP:FAILED mongodb-org did not install (mongod.service missing)"
  echo "MONGO_DIAG_START"
  echo "--- rpm mongodb ---"
  rpm -qa | grep -i mongo | sed 's/^/PKG:/' || echo "PKG: none installed"
  echo "--- dnf list mongodb-org ---"
  dnf list --available mongodb-org 2>&1 | sed 's/^/POL:/'
  echo "--- mongodb repo file ---"
  cat /etc/yum.repos.d/mongodb-org.repo | sed 's/^/REPO:/'
  echo "MONGO_DIAG_END"
  tag_status "failed" "mongodb_not_installed"
  PUB_IP=$(curl -s -H "X-aws-ec2-metadata-token: $(curl -s -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')" http://169.254.169.254/latest/meta-data/public-ipv4)
  echo "PRITUNL_READY_JSON_START"
  echo "{\"status\": \"failed\", \"error\": \"mongodb_not_installed\", \"public_ip\": \"$PUB_IP\"}"
  echo "PRITUNL_READY_JSON_END"
  exit 1
fi

echo "STEP:Installing Pritunl..."
# pritunl-openvpn is Pritunl's own OpenVPN build (replaces the base openvpn).
dnf -y install pritunl pritunl-openvpn wireguard-tools

systemctl daemon-reload
systemctl enable mongod pritunl
systemctl start mongod || true

echo "STEP:Waiting for MongoDB..."
# Hard gate: mongod MUST be listening on 27017 before we touch Pritunl.
# We retry the start a few times and wait for the TCP port to actually
# accept connections -- a live systemd unit isn't enough, the port has to
# be open. If it never comes up we dump the journal and abort, instead of
# silently falling through to Pritunl (which then fails with "Connection
# refused" and leaves a broken install).
MONGO_UP=0
for attempt in $(seq 1 5); do
  systemctl start mongod || true
  for i in $(seq 1 30); do
    if mongosh --quiet --eval 'db.runCommand({ping:1})' >/dev/null 2>&1; then
      MONGO_UP=1
      break
    fi
    # If the unit has died, break out early and re-try starting it.
    if ! systemctl is-active --quiet mongod; then
      break
    fi
    sleep 2
  done
  [ "$MONGO_UP" = "1" ] && break
  echo "STEP:MongoDB not up yet (attempt $attempt), restarting mongod..."
  systemctl restart mongod || true
  sleep 3
done

if [ "$MONGO_UP" != "1" ]; then
  # Compact, single diagnostic block. We abort here on purpose: running
  # Pritunl against a dead MongoDB just floods the console with huge pymongo
  # tracebacks that push these lines out of AWS's limited console buffer.
  EXIT_CODE=$(systemctl show mongod -p ExecMainStatus --value 2>/dev/null)
  RESULT=$(systemctl show mongod -p Result --value 2>/dev/null)
  echo "STEP:FAILED MongoDB did not start"
  echo "MONGO_DIAG_START"
  echo "ExecMainStatus=$EXIT_CODE Result=$RESULT ActiveState=$(systemctl is-active mongod)"
  echo "--- journalctl -u mongod (last 25) ---"
  journalctl -u mongod --no-pager -n 25 2>/dev/null | sed 's/^/JD:/'
  echo "--- mongod.log (last 25) ---"
  tail -n 25 /var/log/mongodb/mongod.log 2>/dev/null | sed 's/^/ML:/'
  echo "--- cpu flags (avx?) ---"
  grep -o 'avx[0-9]*' /proc/cpuinfo | sort -u | tr '\n' ' '; echo
  echo "MONGO_DIAG_END"

  tag_status "failed" "mongodb_did_not_start"
  PUB_IP=$(curl -s -H "X-aws-ec2-metadata-token: $(curl -s -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')" http://169.254.169.254/latest/meta-data/public-ipv4)
  echo "PRITUNL_READY_JSON_START"
  echo "{\"status\": \"failed\", \"error\": \"mongodb_did_not_start\", \"public_ip\": \"$PUB_IP\"}"
  echo "PRITUNL_READY_JSON_END"
  exit 1
fi

# Pritunl does not connect to MongoDB on its own -- this is normally set by
# the first-run web setup wizard. Setting it here lets the whole install
# proceed without ever touching that wizard.
pritunl set-mongodb 'mongodb://localhost:27017/pritunl'

systemctl restart pritunl

echo "STEP:Waiting for services to come up..."
for i in $(seq 1 60); do
  systemctl is-active --quiet mongod && curl -sk --max-time 3 https://localhost/ >/dev/null 2>&1 && break
  sleep 5
done

echo "STEP:Configuring VPN..."

# NOTE: We intentionally do NOT auto-create the org/server via the Pritunl
# REST API. Per the official docs (https://docs.pritunl.com/docs/api) the API
# requires an enterprise subscription -- on the open-source build every token
# request returns "401 Unauthorized" no matter how the request is signed.
# There is also no free CLI command to create orgs/servers. So the deploy
# provisions a fully working Pritunl and hands off the org/server creation to
# the web UI (a two-minute task documented under "Connecting").

# Make sure Pritunl has finished bootstrapping and is serving HTTPS before we
# reset the admin password below.
for i in $(seq 1 60); do
  curl -sk --max-time 3 https://localhost/ >/dev/null 2>&1 && break
  sleep 5
done

echo "STEP:Finalizing admin credentials..."
RESET_OUT=$(pritunl reset-password 2>&1)

# Pritunl prints (with ANSI color codes) lines like:
#   [local][...][INFO] Resetting administrator password    <- decoy, has "password"
#     username: "pritunl"
#     password: "1aGt3gxjWlSr"                             <- the real value
# Strip ANSI codes first, then match ONLY lines that have a quoted value after
# the label. The old code did a plain grep for password and took the first
# line, which grabbed the "Resetting administrator password" log line and
# produced an empty password.
RESET_CLEAN=$(echo "$RESET_OUT" | sed -E 's/\x1b\[[0-9;]*m//g')
ADMIN_USER=$(echo "$RESET_CLEAN" | sed -nE 's/.*username:[[:space:]]*"([^"]+)".*/\1/p' | head -1)
ADMIN_PASS=$(echo "$RESET_CLEAN" | sed -nE 's/.*password:[[:space:]]*"([^"]+)".*/\1/p' | head -1)

# Fallback for a Pritunl version that doesn't quote the values: take the token
# after the label, but only on a line that isn't the "Resetting..." log line.
if [ -z "$ADMIN_USER" ]; then
  ADMIN_USER=$(echo "$RESET_CLEAN" | grep -iE '^\s*username[: ]' | sed -E 's/.*[Uu]sername[: ]*//' | tr -d '"\r' | xargs | head -1)
fi
if [ -z "$ADMIN_PASS" ]; then
  ADMIN_PASS=$(echo "$RESET_CLEAN" | grep -iE '^\s*password[: ]' | sed -E 's/.*[Pp]assword[: ]*//' | tr -d '"\r' | xargs | head -1)
fi
[ -z "$ADMIN_USER" ] && ADMIN_USER="pritunl"

IMDS_TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
PUB_IP=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4)
INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/instance-id)
AZ=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/placement/availability-zone)
REGION=$(echo "$AZ" | sed -E 's/[a-z]$//')

# Report status back to the browser via the instance's OWN tags. This is the
# reliable channel: tags are structured and instant, unlike console output
# which AWS delays for minutes and truncates. The instance profile grants only
# ec2:CreateTags. The admin password is short enough to fit the 256-char tag
# value limit. (AWS CLI v2 is preinstalled on Amazon Linux 2023.)
echo "STEP:Publishing status tags..."
for i in $(seq 1 10); do
  if aws ec2 create-tags --region "$REGION" --resources "$INSTANCE_ID" --tags \
      "Key=PritunlStatus,Value=ready" \
      "Key=PritunlUser,Value=$ADMIN_USER" \
      "Key=PritunlPass,Value=$ADMIN_PASS" \
      "Key=PritunlIp,Value=$PUB_IP"; then
    echo "TAGS_WRITTEN=1"
    break
  fi
  echo "TAGS_WRITE_RETRY=$i"
  sleep 3
done

echo "STEP:Pritunl Ready"
echo "PRITUNL_READY_JSON_START"
ADMIN_USER="$ADMIN_USER" ADMIN_PASS="$ADMIN_PASS" PUB_IP="$PUB_IP" RESET_OUT="$RESET_OUT" python3 << 'PYEOF2'
import json, os
print(json.dumps({
  "status": "ready",
  "admin_username": os.environ.get("ADMIN_USER", "pritunl"),
  "admin_password": os.environ.get("ADMIN_PASS", ""),
  "admin_reset_raw": os.environ.get("RESET_OUT", ""),
  "public_ip": os.environ.get("PUB_IP", ""),
  "setup_required": True,
}))
PYEOF2
echo "PRITUNL_READY_JSON_END"
`;

async function validateCredentials(creds) {
  const sts = new STSClient({ region: REGION, credentials: creds });
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  return identity;
}

function ipPermission(protocol, port) {
  return {
    IpProtocol: protocol,
    FromPort: port,
    ToPort: port,
    IpRanges: [{ CidrIp: "0.0.0.0/0" }],
  };
}

// Creates (or reuses) an IAM role + instance profile that lets the instance
// tag ITSELF. This is how the instance reports deploy status/password/IP back
// to the browser via EC2 tags -- reliable and instant, unlike console output.
// Idempotent: if a previous run already created these, we reuse them.
async function ensureInstanceProfile(iam) {
  // If the instance profile already exists (and has the role), reuse it.
  try {
    const existing = await iam.send(new GetInstanceProfileCommand({ InstanceProfileName: INSTANCE_PROFILE_NAME }));
    if (existing.InstanceProfile && existing.InstanceProfile.Roles && existing.InstanceProfile.Roles.length > 0) {
      return;
    }
  } catch (e) {
    if (e.name !== "NoSuchEntityException" && e.name !== "NoSuchEntity") {
      // Anything other than "doesn't exist yet" is a real problem (e.g. the
      // credentials lack IAM permissions) -- surface it clearly.
      throw new Error(`IAM check failed (${e.name || "error"}): ${e.message}. ` +
        `Your AWS credentials need iam:GetInstanceProfile/CreateRole/CreateInstanceProfile/PassRole and ec2:CreateTags.`);
    }
  }

  const assumeRolePolicy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" }],
  });

  // Create the role (ignore "already exists" so reruns are safe).
  try {
    await iam.send(new CreateRoleCommand({
      RoleName: ROLE_NAME,
      AssumeRolePolicyDocument: assumeRolePolicy,
      Description: "Allows a Pritunl sandbox instance to tag itself with deploy status.",
    }));
  } catch (e) {
    if (e.name !== "EntityAlreadyExistsException") throw e;
  }

  // Least-privilege inline policy: only ec2:CreateTags.
  await iam.send(new PutRolePolicyCommand({
    RoleName: ROLE_NAME,
    PolicyName: "self-tag",
    PolicyDocument: JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: ["ec2:CreateTags"], Resource: "*" }],
    }),
  }));

  // Create the instance profile and attach the role (ignore "already exists").
  try {
    await iam.send(new CreateInstanceProfileCommand({ InstanceProfileName: INSTANCE_PROFILE_NAME }));
  } catch (e) {
    if (e.name !== "EntityAlreadyExistsException") throw e;
  }
  try {
    await iam.send(new AddRoleToInstanceProfileCommand({
      InstanceProfileName: INSTANCE_PROFILE_NAME,
      RoleName: ROLE_NAME,
    }));
  } catch (e) {
    if (e.name !== "LimitExceededException") throw e; // already has a role
  }

  // IAM is eventually consistent: a just-created instance profile may not be
  // usable by RunInstances for a few seconds. Give it a moment.
  await sleep(10000);
}

async function deploy(creds) {
  const ec2 = new EC2Client({ region: REGION, credentials: creds });
  const ssm = new SSMClient({ region: REGION, credentials: creds });
  const iam = new IAMClient({ region: REGION, credentials: creds });

  setStep("validate", "active");
  await validateCredentials(creds);
  setStep("validate", "done");

  setStep("vpc", "active");
  const vpc = await ec2.send(new CreateVpcCommand({ CidrBlock: "10.0.0.0/16" }));
  const vpcId = vpc.Vpc.VpcId;
  await ec2.send(new ModifyVpcAttributeCommand({ VpcId: vpcId, EnableDnsSupport: { Value: true } }));
  await ec2.send(new ModifyVpcAttributeCommand({ VpcId: vpcId, EnableDnsHostnames: { Value: true } }));
  setStep("vpc", "done", vpcId);

  setStep("igw", "active");
  const igw = await ec2.send(new CreateInternetGatewayCommand({}));
  const igwId = igw.InternetGateway.InternetGatewayId;
  await ec2.send(new AttachInternetGatewayCommand({ InternetGatewayId: igwId, VpcId: vpcId }));
  setStep("igw", "done", igwId);

  setStep("subnet", "active");
  const azs = await ec2.send(new DescribeAvailabilityZonesCommand({
    Filters: [{ Name: "region-name", Values: [REGION] }, { Name: "state", Values: ["available"] }],
  }));
  const az = azs.AvailabilityZones[0].ZoneName;
  const subnet = await ec2.send(new CreateSubnetCommand({ VpcId: vpcId, CidrBlock: "10.0.1.0/24", AvailabilityZone: az }));
  const subnetId = subnet.Subnet.SubnetId;
  await ec2.send(new ModifySubnetAttributeCommand({ SubnetId: subnetId, MapPublicIpOnLaunch: { Value: true } }));
  setStep("subnet", "done", `${subnetId} (${az})`);

  setStep("routes", "active");
  const rt = await ec2.send(new CreateRouteTableCommand({ VpcId: vpcId }));
  const rtId = rt.RouteTable.RouteTableId;
  await ec2.send(new CreateRouteCommand({ RouteTableId: rtId, DestinationCidrBlock: "0.0.0.0/0", GatewayId: igwId }));
  await ec2.send(new AssociateRouteTableCommand({ RouteTableId: rtId, SubnetId: subnetId }));
  setStep("routes", "done", rtId);

  setStep("sg", "active");
  const sg = await ec2.send(new CreateSecurityGroupCommand({
    GroupName: `pritunl-sandbox-${Date.now()}`,
    Description: "Pritunl sandbox",
    VpcId: vpcId,
  }));
  const sgId = sg.GroupId;
  await ec2.send(new AuthorizeSecurityGroupIngressCommand({
    GroupId: sgId,
    IpPermissions: [
      ipPermission("tcp", 443),
      ipPermission("tcp", 80),
      ipPermission("udp", 1194),
      ipPermission("udp", 51820),
    ],
  }));
  setStep("sg", "done", sgId);

  setStep("iam", "active");
  await ensureInstanceProfile(iam);
  setStep("iam", "done", INSTANCE_PROFILE_NAME);

  setStep("ami", "active");
  const param = await ssm.send(new GetParameterCommand({ Name: AMI_PARAM }));
  const amiId = param.Parameter.Value;
  const images = await ec2.send(new DescribeImagesCommand({ ImageIds: [amiId] }));
  const rootDevice = images.Images[0].RootDeviceName || "/dev/sda1";
  setStep("ami", "done", amiId);

  setStep("ec2", "active");
  const userDataB64 = btoa(unescape(encodeURIComponent(USER_DATA)));
  const runParams = {
    ImageId: amiId,
    InstanceType: "t3.small",
    MinCount: 1,
    MaxCount: 1,
    UserData: userDataB64,
    IamInstanceProfile: { Name: INSTANCE_PROFILE_NAME },
    MetadataOptions: { HttpTokens: "required", HttpEndpoint: "enabled" },
    BlockDeviceMappings: [{
      DeviceName: rootDevice,
      Ebs: { VolumeSize: 20, VolumeType: "gp3", Encrypted: true, DeleteOnTermination: true },
    }],
    NetworkInterfaces: [{
      DeviceIndex: 0,
      SubnetId: subnetId,
      Groups: [sgId],
      AssociatePublicIpAddress: true,
    }],
    TagSpecifications: [{ ResourceType: "instance", Tags: [{ Key: "Name", Value: "pritunl-sandbox" }] }],
  };
  // RunInstances can reject a just-created instance profile with
  // "Invalid IAM Instance Profile" due to IAM eventual consistency. Retry.
  let run;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      run = await ec2.send(new RunInstancesCommand(runParams));
      break;
    } catch (e) {
      const retryable = /Invalid IAM Instance Profile|not authorized to perform: iam:PassRole/i.test(e.message || "");
      if (!retryable || attempt === 6) throw e;
      setStep("ec2", "active", `waiting for IAM profile to propagate (attempt ${attempt})`);
      await sleep(5000);
    }
  }
  const instanceId = run.Instances[0].InstanceId;
  setStep("ec2", "done", instanceId);
  els.instanceBox.classList.remove("hidden");
  els.instanceId.textContent = instanceId;

  setStep("boot", "active");
  let publicIp = null;
  for (let i = 0; i < 40; i++) {
    const desc = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const inst = desc.Reservations[0].Instances[0];
    if (inst.State.Name === "running" && inst.PublicIpAddress) {
      publicIp = inst.PublicIpAddress;
      break;
    }
    await sleep(5000);
  }
  if (!publicIp) throw new Error("Instance did not reach 'running' with a public IP in time.");
  setStep("boot", "done", publicIp);
  els.publicIp.textContent = publicIp;

  setStep("install", "active");
  els.waitNote.classList.remove("hidden");
  els.refreshBtn.classList.remove("hidden");
  els.toggleLogBtn.classList.remove("hidden");

  const result = await pollInstanceTags(ec2, instanceId, publicIp);
  if (result && result.status === "failed") {
    throw new Error(
      `Instance setup failed: ${result.error || "unknown"}. ` +
      `Open the raw console output above for full diagnostics.`
    );
  }

  setStep("install", "done");
  setStep("configure", "done");
  setStep("ready", "done");

  showResult(publicIp, result);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function base64ToUtf8(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

let lastRawLog = "";

// Read the instance's own tags. The user-data writes PritunlStatus / PritunlUser
// / PritunlPass / PritunlIp when it finishes (or PritunlStatus=failed on error).
// Tags are instant and never truncated -- the reliable completion signal.
function tagsToObject(inst) {
  const out = {};
  for (const t of inst.Tags || []) out[t.Key] = t.Value;
  return out;
}

// Refresh the raw console log view (debug only -- no longer the completion
// signal). Best-effort; ignored if AWS hasn't produced output yet.
async function refreshConsole(ec2, instanceId) {
  try {
    const out = await ec2.send(new GetConsoleOutputCommand({ InstanceId: instanceId }));
    if (out.Output) {
      lastRawLog = base64ToUtf8(out.Output);
      els.rawLog.textContent = lastRawLog;
    }
  } catch (e) {
    /* ignore -- console output is optional */
  }
}

async function pollInstanceTags(ec2, instanceId, publicIp) {
  return new Promise((resolve) => {
    let stopped = false;

    async function check() {
      if (stopped) return;

      try {
        const desc = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
        const inst = desc.Reservations[0].Instances[0];
        const tags = tagsToObject(inst);

        // Keep the debug console view fresh in the background.
        refreshConsole(ec2, instanceId);

        if (tags.PritunlStatus === "ready") {
          stopped = true;
          resolve({
            status: "ready",
            admin_username: tags.PritunlUser || "pritunl",
            admin_password: tags.PritunlPass || "",
            public_ip: tags.PritunlIp || publicIp,
            setup_required: true,
          });
          return;
        }

        if (tags.PritunlStatus === "failed") {
          stopped = true;
          resolve({ status: "failed", error: tags.PritunlError || "unknown", public_ip: publicIp });
          return;
        }

        els.waitNote.textContent =
          `Last checked at ${new Date().toLocaleTimeString()} — installing on the instance ` +
          `(waiting for it to report ready via its tags)…`;
      } catch (e) {
        console.warn("tag poll failed", e);
        els.waitNote.textContent =
          `Last checked at ${new Date().toLocaleTimeString()} — error reading instance tags: ${e.message || e}`;
      }

      setTimeout(check, 8000);
    }

    els.refreshBtn.onclick = check;
    check();
  });
}

function showResult(publicIp, parsed) {
  els.progressPanel.classList.add("hidden");
  els.resultPanel.classList.remove("hidden");
  els.resPublicIp.textContent = publicIp;
  els.resUrl.textContent = `https://${publicIp}`;
  els.openBtn.onclick = () => window.open(`https://${publicIp}`, "_blank");

  if (parsed && parsed.password_unavailable) {
    // We finished via the HTTPS probe before the console surfaced the password.
    els.credsBox.classList.remove("hidden");
    els.resUser.textContent = "pritunl";
    els.resPass.textContent =
      "(not captured — SSH/SSM to the instance and run: sudo pritunl reset-password)";
  } else if (parsed && parsed.admin_username) {
    els.credsBox.classList.remove("hidden");
    els.resUser.textContent = parsed.admin_username;
    if (parsed.admin_password) {
      els.resPass.textContent = parsed.admin_password;
    } else if (parsed.admin_reset_raw) {
      els.resPass.textContent = `(parse failed — raw: ${parsed.admin_reset_raw.replace(/\s+/g, " ").trim()})`;
    } else {
      els.resPass.textContent = "(run: sudo pritunl reset-password on the instance)";
    }
  }

  // The open-source Pritunl build can't be configured via the API (enterprise
  // only), so the org/server are created in the web UI. Show the short steps.
  if (parsed && parsed.setup_required) {
    let note = document.getElementById("setupNote");
    if (!note) {
      note = document.createElement("div");
      note.id = "setupNote";
      note.className = "kv";
      els.resultPanel.appendChild(note);
    }
    note.innerHTML =
      `<div style="display:block"><span>Next steps (in the Pritunl web console)</span>` +
      `<ol style="margin:8px 0 0 18px;line-height:1.6">` +
      `<li>Log in with the admin username and password above.</li>` +
      `<li>On first login, complete the setup screen (the MongoDB URI is already set — just submit).</li>` +
      `<li>Add Organization → name it, e.g. <code>Sandbox</code>.</li>` +
      `<li>Add Server → set port <code>1194</code>/UDP, then attach the organization.</li>` +
      `<li>Add Route <code>0.0.0.0/0</code> if you want full-tunnel, then Start the server.</li>` +
      `<li>Add a User under the organization and download its profile to connect.</li>` +
      `</ol></div>`;
  }
}

els.toggleLogBtn.addEventListener("click", () => {
  els.rawLog.classList.toggle("hidden");
  els.toggleLogBtn.textContent = els.rawLog.classList.contains("hidden") ? "Show raw console output" : "Hide raw console output";
});

els.deployBtn.addEventListener("click", async () => {
  els.formError.classList.add("hidden");
  const accessKeyId = document.getElementById("accessKeyId").value.trim();
  const secretAccessKey = document.getElementById("secretAccessKey").value.trim();
  const sessionToken = document.getElementById("sessionToken").value.trim();

  if (!accessKeyId || !secretAccessKey) {
    els.formError.textContent = "Access Key ID and Secret Access Key are required.";
    els.formError.classList.remove("hidden");
    return;
  }

  const creds = { accessKeyId, secretAccessKey };
  if (sessionToken) creds.sessionToken = sessionToken;

  // Clear the secret fields from the DOM immediately; we only keep the
  // values in this closure's local variables for the duration of the run.
  document.getElementById("secretAccessKey").value = "";
  document.getElementById("sessionToken").value = "";

  els.deployBtn.disabled = true;
  els.form.classList.add("hidden");
  els.progressPanel.classList.remove("hidden");
  buildProgressUI();

  try {
    await deploy(creds);
  } catch (e) {
    const activeStep = STEPS.find(([id]) => document.getElementById(`step-${id}`)?.classList.contains("active"));
    fail(activeStep ? activeStep[0] : STEPS[0][0], e);
  }
});

// Signals to index.html that the module fully evaluated and the click handler
// above is attached. If this never runs, the SDK import was blocked.
window.__deployerReady = true;
