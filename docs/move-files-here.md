# Move topology files from your SSH client machine

Run one of these commands on the machine that has the zip/folder in Downloads.

## Zip file

Linux/macOS:

```bash
scp ~/Downloads/<topologies>.zip sonik@192.168.1.233:/home/sonik/.openclaw/workspace/rabbit-topology-visualizer/data/raw/
```

Windows PowerShell:

```powershell
scp "$env:USERPROFILE\Downloads\<topologies>.zip" sonik@192.168.1.233:/home/sonik/.openclaw/workspace/rabbit-topology-visualizer/data/raw/
```

## Folder

```bash
rsync -av ~/Downloads/<topology-folder>/ sonik@192.168.1.233:/home/sonik/.openclaw/workspace/rabbit-topology-visualizer/data/raw/<topology-folder>/
```

If SSH uses a non-default port or key, add the same `-p` / `-i` options you use for normal SSH. Keep raw files out of git until sanitized.
