# 195.201.13.95 — measured, 2026-08-23

Read off the box, not inferred. Everything the runbook asserts about this machine
traces to this file. Re-measure with the block in `RECON.json` if it drifts.

## Machine

|          |                                                                                             |
| -------- | ------------------------------------------------------------------------------------------- |
| CPU      | Intel Xeon E3-1275 v6 @ 3.80 GHz — 4 cores / 8 threads                                      |
| RAM      | 62 GiB usable (`free -h` total), 1.0 GiB in use at rest                                     |
| Swap     | 8 GiB, on LVM (`vg0-swap`), currently 0 B used                                              |
| Disks    | 2 × 476.9 GB NVMe, **software RAID1** — `md0` (1 GiB) → `/boot`, `md1` (475.8 GiB) → LVM PV |
| RAID     | Both arrays `[UU]` — healthy, no degradation                                                |
| OS       | Ubuntu 26.04 LTS, kernel 7.0.0-30-generic                                                   |
| Timezone | **Europe/Berlin**                                                                           |
| Uptime   | 1 day 19 h at time of measurement — freshly provisioned                                     |

**This is the same hardware model as the lost box.** The capacity numbers in the
old documents were therefore not wrong, only unverified. They are now verified.

## Storage layout

```
vg0 (475.81 GiB PV on md1)
├── vg0-root   80 GiB  ext4  /              3.0G used of 79G   (4%)
├── vg0-data  250 GiB  ext4  /mnt/libriant   28K used of 246G  (1%)
└── vg0-swap    8 GiB  swap  [SWAP]
    137.81 GiB UNALLOCATED — the growth headroom
```

`/mnt/libriant` is mounted (`/dev/mapper/vg0-data`, ext4, rw,relatime) but is an
**empty directory owned by root:root**. None of the four bind-mount targets the
compose overlay needs exist yet.

## Network

|           |                                                               |
| --------- | ------------------------------------------------------------- |
| Interface | `enp0s31f6`                                                   |
| IPv4      | `195.201.13.95/32`                                            |
| IPv6      | `2a01:4f8:13b:ac8::2/64` — **the box has public IPv6**        |
| Listening | port 22 only (plus systemd-resolved on 127.0.0.53/127.0.0.54) |

IPv6 matters and is easy to miss: any firewall rule written only for IPv4 leaves
v6 wide open.

> **Superseded, 2026-08-28 — the second half of this note used to read "DNS needs
> AAAA records or IPv6 clients silently miss the host". That inference is wrong
> for this architecture and RUNBOOK §5.4 now forbids acting on it.** The
> measurement above stands: the box does have public IPv6. But the origin
> publishes on IPv4 only (`EDGE_BIND_IPV4`, RUNBOOK §3.2c layer 2), so there is
> no `[::]` listener on 80 or 443 — and because Cloudflare fronts the site, IPv6
> clients reach it through Cloudflare's own AAAA records, not the origin's.
> Creating an `AAAA` record for the origin gives you a 522 on the v6 path only,
> intermittently, while every v4 check passes. **A records only.** See RUNBOOK
> §5.4 step 5.

## What is installed

| Present                                   | Absent                                             |
| ----------------------------------------- | -------------------------------------------------- |
| `git` 2.53.0, `curl` 8.18.0, `ufw` 0.36.2 | **docker**, **docker compose**, node, psql, rclone |

## State — this box is bare

- No `deploy` user. No `docker` group.
- `/srv/libriant`, `/srv/libriant/app`, `/srv/libriant/.env.prod` — all **absent**.
- No containers, no images, no volumes.

## Two security gaps, live right now

1. **`ufw` is installed but `Status: inactive`.** There is no host firewall. Port
   22 is exposed to the internet with nothing in front of it.
2. **`passwordauthentication yes`** in the effective sshd config. `permitrootlogin`
   is `prohibit-password`, so root is key-only — but every other account that
   exists, or is created later, can be brute-forced over the network. This must be
   `no` before the box carries anything.

## Two things to decide

- **Timezone is Europe/Berlin**, not Europe/Athens. Cron times, log timestamps and
  the backup window are all in Berlin time. Greece is UTC+3 to Berlin's UTC+2, so a
  "03:00 backup" runs at 04:00 local for the customers. Either change it or write
  the runbook in Berlin time deliberately.
- **137.81 GiB of vg0 is unallocated.** That is the expansion path for
  `/mnt/libriant` (`lvextend` + `resize2fs`, online, no downtime) and it should be
  the documented answer to "the data volume is filling up".
