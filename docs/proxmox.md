# Proxmox VE

The `proxmox` provider provisions QEMU virtual machines through the Proxmox VE
REST API. Each saved connection targets one cluster; select that connection when
running actions. All 15 actions execute locally.

## Connect a cluster

In **Providers > Proxmox VE**, add a connection with:

- `baseUrl`: an HTTP or HTTPS node origin, such as `https://pve.example.com:8006`, or its
  `/api2/json` root. Include the port explicitly when using Proxmox's default 8006.
- `tokenId`: the full token ID, for example `automation@pve!connector`.
- `tokenSecret`: the secret shown when creating the API token.

Create tokens under **Datacenter > Permissions > API Tokens**. With privilege
separation enabled, grant ACLs to both the user and token: effective access is
their intersection. Connection validation reads `/access/permissions`, so a token
can connect without cluster-wide administrator permissions. An empty resource list
can mean the token has no visibility, not that the cluster is empty.

Typical permissions depend on the operation and resource:

| Operation                | Proxmox privileges                                                       |
| ------------------------ | ------------------------------------------------------------------------ |
| Inspect a VM             | `VM.Audit` on the VM                                                     |
| Create a VM              | `VM.Allocate` on the destination VM or pool                              |
| Clone                    | `VM.Clone` on the source and `VM.Allocate` on the destination VM or pool |
| Allocate disks           | `Datastore.AllocateSpace` on the selected storage                        |
| Read storage contents    | `Datastore.Audit` or `Datastore.AllocateSpace`                           |
| Attach network           | `SDN.Use` on the selected bridge/VNet                                    |
| Configure                | Relevant `VM.Config.*` privileges for the fields being changed           |
| Start or shut down       | `VM.PowerMgmt` on the VM                                                 |
| Read another user's task | `Sys.Audit` on its node; own tasks do not require it                     |

The action catalog lists potentially required privileges; storage and network
permissions depend on the requested configuration. Permissions are resource-scoped,
so connection validation does not flatten them into global granted scopes.

For private clusters, including Tailscale, run Open Connector on a host with network
access and set `OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK=true`. HTTP endpoints over
Tailscale are supported; use the scheme and port served by your node or reverse
proxy. Cloudflare Workers cannot reach a private LAN. Loopback and cloud-metadata
targets remain blocked. For HTTPS, TLS verification stays enabled: use a trusted
certificate or configure your Node deployment's CA
trust (for example `NODE_EXTRA_CA_CERTS` for a private CA). There is no insecure TLS
switch, automatic redirect following, or automatic retry of provisioning requests.

## Agent provisioning workflow

1. Use `list_nodes`, `list_resources` with `type: "vm"`, `list_storage`, and
   `list_networks` to select a node, template, storage, and bridge.
2. Call `get_next_vmid`. This finds an unused ID but does not reserve it.
3. Prefer `clone_vm` from an installed cloud-init template. Alternatively,
   `create_vm` allocates a new VM; a blank disk still needs OS installation.
   `list_storage_content` discovers existing installation ISOs.
4. Poll `get_task_status` with the returned **node and upid**. Only
   `status: "stopped"` and `exitstatus: "OK"` indicate success. Use `get_task_log`
   for failure details, paging with `start` and `limit`.
5. Read `get_vm_config`, then call `update_vm_config` with the returned digest,
   desired CPU/RAM, `ciuser`, raw public `sshkeys`, and `ipconfig0`.
6. Call `start_vm`, poll its task, then check `get_vm_status`.

For a cross-node clone, task polling uses the returned `node`; subsequent VM
operations use `targetNode`. Cross-node cloning requires shared source storage.
Full clones are the default; `full: false` requests a linked template clone.
The `storage` override is only supported for full clones.

Example creation input (replace resource names with discovered values):

```json
{
  "node": "pve1",
  "vmid": 101,
  "name": "agent-vm",
  "cores": 2,
  "memory": 2048,
  "scsihw": "virtio-scsi-single",
  "scsi0": "local-lvm:32",
  "net0": "virtio,bridge=vmbr0",
  "ide2": "local:iso/installer.iso,media=cdrom",
  "boot": "order=ide2;scsi0"
}
```

Provisioning can continue after an HTTP timeout. Inspect the VM ID and tasks before
retrying to avoid duplicate work. Configuration updates can leave pending changes
on running VMs. `shutdown_vm` requests graceful shutdown without a forced stop.
The initial provider does not expose VM deletion, LXC provisioning, host shell
execution, image uploads, or arbitrary API proxy access.

Reference: [Proxmox API viewer](https://pve.proxmox.com/pve-docs/api-viewer/)
and [Proxmox user and token management](https://pve.proxmox.com/pve-docs/pveum-plain.html).
