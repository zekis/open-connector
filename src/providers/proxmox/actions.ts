import type { ActionDefinition, JsonSchema } from "../../core/types.ts";

import { jsonSchema as s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const node = s.string("Cluster node name returned by list_nodes.", { pattern: "^[A-Za-z0-9][A-Za-z0-9.-]*$" });
const vmid = s.integer("Cluster-wide VM ID. Use get_next_vmid to find an available ID; it is not reserved.", {
  minimum: 100,
  maximum: 999999999,
});
const storage = s.string("Storage ID returned by list_storage.", { pattern: "^[A-Za-z][A-Za-z0-9_-]*$" });
const upid = s.nonEmptyString(
  "Task UPID returned by create, clone, start, or shutdown. Poll on the node returned with the task.",
);
const vmInput = s.object({ node, vmid }, { required: ["node", "vmid"] });
const taskOutput = s.object({ node, vmid, upid }, { required: ["node", "vmid", "upid"] });

// These are the supported provisioning options, not an unrestricted API parameter bag.
const vmOptions: Record<string, JsonSchema> = {
  name: s.nonEmptyString("VM display name, using a DNS-compatible name."),
  description: s.string("Notes about this VM."),
  cores: s.integer("CPU cores per socket.", { minimum: 1 }),
  sockets: s.integer("CPU socket count.", { minimum: 1 }),
  memory: s.integer("Memory in MiB.", { minimum: 16 }),
  cpu: s.nonEmptyString("Proxmox CPU model, such as x86-64-v2-AES or host. Host limits migration compatibility."),
  scsihw: s.stringEnum(["lsi", "lsi53c810", "virtio-scsi-pci", "virtio-scsi-single", "megasas", "pvscsi"]),
  scsi0: s.nonEmptyString(
    "Primary SCSI disk, e.g. local-lvm:32 to allocate 32 GiB. Existing volume IDs use Proxmox disk syntax.",
  ),
  ide2: s.nonEmptyString(
    "CD-ROM or cloud-init drive, e.g. local:iso/installer.iso,media=cdrom or local-lvm:cloudinit.",
  ),
  net0: s.nonEmptyString(
    "Primary NIC in Proxmox syntax, e.g. virtio,bridge=vmbr0,firewall=1. Discover the bridge first.",
  ),
  boot: s.nonEmptyString("Boot options, e.g. order=scsi0;ide2;net0."),
  ostype: s.stringEnum([
    "other",
    "wxp",
    "w2k",
    "w2k3",
    "w2k8",
    "wvista",
    "win7",
    "win8",
    "win10",
    "win11",
    "l24",
    "l26",
    "solaris",
  ]),
  agent: s.boolean("Enable the QEMU guest agent; it must also be installed in the guest."),
  onboot: s.boolean("Start the VM automatically when its host boots."),
  ciuser: s.nonEmptyString("Cloud-init login user. Requires a cloud-init image and drive."),
  sshkeys: s.nonEmptyString(
    "Cloud-init public SSH keys, one per line, in raw OpenSSH format. Do not URL-encode or supply private keys.",
  ),
  ipconfig0: s.nonEmptyString("Cloud-init networking, e.g. ip=dhcp or ip=192.0.2.10/24,gw=192.0.2.1."),
  nameserver: s.nonEmptyString("Cloud-init DNS servers in Proxmox syntax."),
  searchdomain: s.nonEmptyString("Cloud-init DNS search domain."),
  serial0: s.stringEnum(["socket"], { description: "Create a serial socket for cloud images." }),
  vga: s.nonEmptyString("Display adapter, e.g. serial0 for a serial-console cloud image."),
  tags: s.string("Semicolon-separated Proxmox tags."),
};

const configOutput = s.object(
  {
    config: s.object(
      {
        ...vmOptions,
        memory: s.anyOf([s.integer(), s.string()]),
        agent: s.anyOf([s.integer(), s.string(), s.boolean()]),
        onboot: s.anyOf([s.integer(), s.boolean()]),
        digest: s.string("Configuration digest for optimistic concurrency on update_vm_config."),
        template: s.anyOf([s.integer(), s.boolean()]),
      },
      { additionalProperties: true },
    ),
  },
  { required: ["config"] },
);

export const proxmoxActions: ActionDefinition[] = [
  defineProviderAction("proxmox", {
    name: "list_nodes",
    description: "List cluster nodes and their available capacity. Choose an online node before provisioning.",
    inputSchema: s.object({}),
    outputSchema: s.object(
      {
        nodes: s.array(
          s.object(
            { node, status: s.string(), maxcpu: s.integer(), maxmem: s.integer(), mem: s.integer(), cpu: s.number() },
            { required: ["node", "status"], additionalProperties: true },
          ),
        ),
      },
      { required: ["nodes"] },
    ),
  }),
  defineProviderAction("proxmox", {
    name: "list_resources",
    description:
      "List cluster resources visible to the token. With type=vm, template=1 identifies templates; type=qemu identifies VMs and type=lxc identifies containers.",
    inputSchema: s.object({ type: s.stringEnum(["vm", "storage", "node", "sdn"]) }),
    outputSchema: s.object(
      {
        resources: s.array(
          s.object(
            {
              id: s.string(),
              type: s.string(),
              node,
              vmid,
              name: s.string(),
              status: s.string(),
              template: s.anyOf([s.integer(), s.boolean()]),
              pool: s.string(),
              maxmem: s.integer(),
              maxdisk: s.integer(),
            },
            { required: ["id", "type"], additionalProperties: true },
          ),
        ),
      },
      { required: ["resources"] },
    ),
  }),
  defineProviderAction("proxmox", {
    name: "list_storage",
    description:
      "List storage visible on a node. Check available space and content includes images before allocating VM disks.",
    inputSchema: s.object(
      { node, content: s.stringEnum(["images", "iso", "vztmpl", "backup", "rootdir", "snippets"]) },
      { required: ["node"] },
    ),
    outputSchema: s.object(
      {
        storage: s.array(
          s.object(
            {
              storage,
              type: s.string(),
              content: s.string(),
              avail: s.integer(),
              total: s.integer(),
              used: s.integer(),
              active: s.anyOf([s.integer(), s.boolean()]),
              enabled: s.anyOf([s.integer(), s.boolean()]),
            },
            { required: ["storage", "type", "content"], additionalProperties: true },
          ),
        ),
      },
      { required: ["storage"] },
    ),
  }),
  defineProviderAction("proxmox", {
    name: "list_storage_content",
    description: "List existing volumes and installation ISOs in a node's storage.",
    inputSchema: s.object(
      { node, storage, content: s.stringEnum(["images", "iso", "vztmpl", "backup", "rootdir", "snippets"]) },
      { required: ["node", "storage"] },
    ),
    outputSchema: s.object(
      {
        volumes: s.array(
          s.object(
            { volid: s.string(), content: s.string(), format: s.string(), size: s.integer() },
            { required: ["volid"], additionalProperties: true },
          ),
        ),
      },
      { required: ["volumes"] },
    ),
    providerPermissions: ["Datastore.Audit", "Datastore.AllocateSpace"],
  }),
  defineProviderAction("proxmox", {
    name: "list_networks",
    description:
      "List node interfaces so you can select an existing bridge for a VM NIC. This does not modify host networking.",
    inputSchema: s.object({ node }, { required: ["node"] }),
    outputSchema: s.object(
      {
        interfaces: s.array(
          s.object(
            {
              iface: s.string(),
              type: s.string(),
              active: s.anyOf([s.integer(), s.boolean()]),
              bridge_ports: s.string(),
            },
            { required: ["iface"], additionalProperties: true },
          ),
        ),
      },
      { required: ["interfaces"] },
    ),
  }),
  defineProviderAction("proxmox", {
    name: "get_next_vmid",
    description:
      "Find the next available cluster-wide VM ID. This does not reserve it; concurrent provisioning can still conflict.",
    inputSchema: s.object({}),
    outputSchema: s.object({ vmid }, { required: ["vmid"] }),
    followUpActions: ["proxmox.create_vm", "proxmox.clone_vm"],
  }),
  defineProviderAction("proxmox", {
    name: "create_vm",
    description:
      "Create a stopped QEMU VM and optionally allocate disks. An empty disk does not install an OS: attach an ISO or clone an installed template. Returns a task, not a completed VM. Wait for exitstatus=OK before configuring or starting. Do not retry blindly after a timeout; inspect the VM ID first.",
    inputSchema: s.object(
      { node, vmid, ...vmOptions, pool: s.nonEmptyString("Optional resource pool for the new VM.") },
      { required: ["node", "vmid", "name"] },
    ),
    outputSchema: taskOutput,
    providerPermissions: ["VM.Allocate", "Datastore.AllocateSpace", "SDN.Use"],
    followUpActions: ["proxmox.get_task_status", "proxmox.get_vm_config", "proxmox.start_vm"],
    asyncLifecycle: { startActionId: "proxmox.create_vm", statusActionId: "proxmox.get_task_status" },
  }),
  defineProviderAction("proxmox", {
    name: "clone_vm",
    description:
      "Clone a QEMU VM or template into a new VM ID. Defaults to a full disk copy. Cross-node target requires shared source storage. Wait for the returned task to stop with exitstatus=OK before configuring or starting the clone. After a timeout, inspect the destination VM before retrying.",
    inputSchema: s.object(
      {
        node,
        vmid,
        newid: vmid,
        name: s.nonEmptyString("Name for the clone."),
        full: s.boolean({ description: "Full copy; false requests a linked clone of a template.", default: true }),
        target: node,
        storage,
        pool: s.nonEmptyString("Destination pool."),
        description: s.string("Clone description."),
      },
      { required: ["node", "vmid", "newid", "name"] },
    ),
    outputSchema: s.object(
      { node, vmid, upid, targetNode: node },
      { required: ["node", "vmid", "upid", "targetNode"] },
    ),
    providerPermissions: ["VM.Clone", "VM.Allocate", "Datastore.AllocateSpace", "SDN.Use"],
    followUpActions: ["proxmox.get_task_status", "proxmox.update_vm_config", "proxmox.start_vm"],
    asyncLifecycle: { startActionId: "proxmox.clone_vm", statusActionId: "proxmox.get_task_status" },
  }),
  defineProviderAction("proxmox", {
    name: "get_vm_config",
    description:
      "Read VM configuration and its digest before updating. Cloud-init SSH keys use Proxmox's encoded representation in this response.",
    inputSchema: vmInput,
    outputSchema: configOutput,
    providerPermissions: ["VM.Audit"],
  }),
  defineProviderAction("proxmox", {
    name: "update_vm_config",
    description:
      "Update supported VM hardware or cloud-init options. Prefer a stopped VM; some changes remain pending until restart. Supply the digest from get_vm_config to reject concurrent edits. Does not resize existing disks.",
    inputSchema: s.object(
      { node, vmid, ...vmOptions, digest: s.nonEmptyString("Digest from get_vm_config.") },
      { required: ["node", "vmid"] },
    ),
    outputSchema: s.object({ node, vmid, updated: s.boolean() }, { required: ["node", "vmid", "updated"] }),
    providerPermissions: [
      "VM.Config.CPU",
      "VM.Config.Memory",
      "VM.Config.Disk",
      "VM.Config.CDROM",
      "VM.Config.Network",
      "VM.Config.HWType",
      "VM.Config.Options",
      "VM.Config.Cloudinit",
    ],
    followUpActions: ["proxmox.get_vm_config", "proxmox.start_vm"],
  }),
  defineProviderAction("proxmox", {
    name: "get_vm_status",
    description: "Read the VM's current power state and resource usage.",
    inputSchema: vmInput,
    outputSchema: s.object(
      {
        status: s.object(
          {
            vmid,
            name: s.string(),
            status: s.stringEnum(["running", "stopped"]),
            qmpstatus: s.string(),
            uptime: s.integer(),
            cpu: s.number(),
            mem: s.integer(),
            maxmem: s.integer(),
          },
          { required: ["vmid", "status"], additionalProperties: true },
        ),
      },
      { required: ["status"] },
    ),
    providerPermissions: ["VM.Audit"],
  }),
  defineProviderAction("proxmox", {
    name: "start_vm",
    description: "Start an existing VM. Poll the returned task until stopped and check exitstatus=OK.",
    inputSchema: vmInput,
    outputSchema: taskOutput,
    providerPermissions: ["VM.PowerMgmt"],
    followUpActions: ["proxmox.get_task_status", "proxmox.get_vm_status"],
    asyncLifecycle: { startActionId: "proxmox.start_vm", statusActionId: "proxmox.get_task_status" },
  }),
  defineProviderAction("proxmox", {
    name: "shutdown_vm",
    description:
      "Request a graceful guest shutdown. Does not forcibly stop the VM if the guest fails to shut down. Poll the task for the result.",
    inputSchema: s.object(
      { node, vmid, timeout: s.integer("Guest shutdown timeout in seconds.", { minimum: 0 }) },
      { required: ["node", "vmid"] },
    ),
    outputSchema: taskOutput,
    providerPermissions: ["VM.PowerMgmt"],
    followUpActions: ["proxmox.get_task_status", "proxmox.get_vm_status"],
    asyncLifecycle: { startActionId: "proxmox.shutdown_vm", statusActionId: "proxmox.get_task_status" },
  }),
  defineProviderAction("proxmox", {
    name: "get_task_status",
    description:
      "Poll an asynchronous operation on its task node. stopped means finished, not necessarily successful: only exitstatus=OK means success. Own tasks are readable; other users' tasks need Sys.Audit.",
    inputSchema: s.object({ node, upid }, { required: ["node", "upid"] }),
    outputSchema: s.object(
      {
        task: s.object(
          {
            upid,
            node,
            status: s.stringEnum(["running", "stopped"]),
            exitstatus: s.string(),
            type: s.string(),
            starttime: s.integer(),
            user: s.string(),
          },
          { required: ["upid", "node", "status"], additionalProperties: true },
        ),
      },
      { required: ["task"] },
    ),
    followUpActions: ["proxmox.get_task_log"],
  }),
  defineProviderAction("proxmox", {
    name: "get_task_log",
    description:
      "Read a page of task log lines when provisioning fails or is still running. Increase start to read subsequent pages.",
    inputSchema: s.object(
      {
        node,
        upid,
        start: s.integer("Zero-based offset.", { minimum: 0 }),
        limit: s.integer("Maximum lines per request.", { minimum: 1, maximum: 500, default: 50 }),
      },
      { required: ["node", "upid"] },
    ),
    outputSchema: s.object(
      { lines: s.array(s.object({ n: s.integer(), t: s.string() }, { required: ["n", "t"] })) },
      { required: ["lines"] },
    ),
  }),
];
