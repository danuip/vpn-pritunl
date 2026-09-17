# Pritunl Sandbox Deployer

A static, single-page deployer that spins up a fully configured Pritunl VPN
server in a disposable AWS sandbox account. Enter temporary AWS credentials,
click **Deploy Pritunl**, and it builds the network from scratch and
configures the VPN server without any further input.

Built with plain HTML/CSS/JS and the **AWS SDK for JavaScript v3** (loaded as
ES modules from esm.sh at runtime — no build step, no `npm install`).

## What it creates

- VPC `10.0.0.0/16`, public subnet `10.0.1.0/24` in the first available AZ in `us-east-1`
- Internet Gateway + public route table (`0.0.0.0/0` → IGW)
- A dedicated security group: TCP 443, TCP 80, UDP 1194, UDP 51820 from `0.0.0.0/0` — **no SSH (22)**
- An Amazon Linux 2023 `t3.small` instance (AMI resolved dynamically via the
  public SSM parameter `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64`),
  20 GB encrypted gp3 root volume, IMDSv2 required, public IPv4
- MongoDB 7.0, Pritunl, and WireGuard installed via user-data (dnf/yum)
- An IAM role + instance profile (`pritunl-sandbox-self-tag`, reused across
  runs) granting only `ec2:CreateTags`, so the instance reports its deploy
  status/credentials back to the browser via its own EC2 tags
- A `Sandbox` organization and a `sandbox` VPN server (OpenVPN/UDP/1194),
  attached to that org, with a `0.0.0.0/0` route, started automatically
- A generated admin password, printed only to the instance's console log

## Deploying to GitHub Pages

1. Create a new GitHub repo and push these four files (`index.html`,
   `app.js`, `style.css`, `README.md`) to the root (or to `/docs`).
2. In the repo, go to **Settings → Pages**, set the source to the branch/folder
   you pushed to, and save.
3. Open the published URL. That's it — there's no build step.

You can also just open `index.html` directly from disk in a browser for local
testing; it makes no calls anywhere except to AWS.

## IAM permissions needed

The temporary credentials you paste in need to be able to run
`ec2:CreateVpc`, `CreateSubnet`, `CreateInternetGateway`,
`AttachInternetGateway`, `CreateRouteTable`, `CreateRoute`,
`AssociateRouteTable`, `CreateSecurityGroup`,
`AuthorizeSecurityGroupIngress`, `DescribeImages`, `DescribeAvailabilityZones`,
`RunInstances`, `DescribeInstances`, `GetConsoleOutput`, plus
`ssm:GetParameter` and `sts:GetCallerIdentity`. In a sandbox account with
admin-level temporary credentials this is already covered.

## How "no manual configuration" actually works

Pritunl's REST API needs an admin account with API token auth enabled, which
is normally a checkbox in the web UI. To avoid ever touching the UI, the
user-data script enables that flag directly on the default admin document in
MongoDB (the same field the checkbox sets), generates a random token/secret,
and then uses the documented Pritunl API (HMAC-signed requests) — all from
`localhost`, root, in the boot script — to create the organization, create
and configure the server, attach the org, add a full-tunnel route, and start
the server. It finishes by resetting the admin password and printing the
username/public IP/URL as a single JSON block to the instance's console
output.

## How the page knows when it's done

There's a real constraint here worth being upfront about: the browser can't
reach the instance's local Pritunl API (self-signed cert, and Pritunl doesn't
expose a plain HTTP status endpoint), and SSH is intentionally closed. So the
page polls `ec2:GetConsoleOutput` every 15 seconds and looks for progress
markers and a final JSON block that the user-data script prints. **AWS only
refreshes console output every 1–5 minutes**, so this is the slowest and
least real-time part of the flow — expect the "Waiting for instance to boot"
→ "Ready" stretch to take several minutes even though the instance itself is
usually done sooner. A "Check status now" button and a raw console-output
viewer are included for visibility while you wait.

## Known limitations / things to sanity-check

- **Pritunl's exact API endpoints can vary a little between versions.** The
  script tries `/server/<id>/start` and falls back to
  `/server/<id>/operation/start`; if a future Pritunl release renames
  something else, that one step could fail. Because SSH is closed by design,
  your recovery options if this happens are: (a) temporarily add an SSH rule
  to the security group from the AWS console/CLI and fix it by hand, since
  it's your account, or (b) redeploy. The full boot log is always at
  `/var/log/pritunl-deploy.log` on the instance and mirrored to the console
  output the page already shows you.
- The VPN route is a full-tunnel `0.0.0.0/0` route by default. Change the
  `network` value in the `/server/.../route` call inside the user-data script
  if you want split-tunnel instead.
- The script also creates one Pritunl user (`sandbox-client`) in the org so a
  client profile exists immediately; download its key/profile from the
  Pritunl web UI's Users tab (Users → sandbox-client → download profile) —
  this part isn't scraped back to the browser since it's a binary archive,
  not a small text block like the admin credentials.
- Credentials you type into the page are held in JS variables for the
  current run only — nothing touches `localStorage`, `sessionStorage`, or
  cookies, and the secret/session-token fields are cleared from the DOM the
  moment you click Deploy. Closing the tab clears everything.
- Nothing here tears infrastructure down — that's intentional, since the
  whole sandbox account is wiped at the end of its ~4-hour life anyway.

## File layout

```
pritunl-deployer/
├── index.html   – the form, progress list, and result screen
├── app.js       – AWS SDK v3 orchestration + the EC2 user-data script
├── style.css    – styling
└── README.md    – this file
```
