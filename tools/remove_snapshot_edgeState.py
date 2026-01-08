#!/usr/bin/env python3
import argparse
import json
import os
import shutil
import datetime


def read_json(p):
    with open(p, 'r', encoding='utf-8') as f:
        return json.load(f)


def write_json(p, data):
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('scenarios', help='Path to scenarios.json')
    args = p.parse_args()

    path = args.scenarios
    if not os.path.exists(path):
        print('File not found:', path)
        return

    data = read_json(path)
    if not isinstance(data, list):
        print('Expected scenarios.json to be a list of scenarios')
        return

    ts = datetime.datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')
    bak = path + f'.bak.removedEdgeState.{ts}'
    shutil.copyfile(path, bak)
    print('Backup written to', bak)

    removed = 0
    for s in data:
        if not isinstance(s, dict):
            continue
        snap = s.get('snapshot')
        if isinstance(snap, dict):
            if 'edgeState' in snap:
                del snap['edgeState']
                removed += 1
            if 'edges' in snap:
                del snap['edges']
                removed += 1

    write_json(path, data)
    print(f'Removed edgeState/edges from {removed} snapshots.')


if __name__ == '__main__':
    main()
