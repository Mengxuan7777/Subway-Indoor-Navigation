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
    p.add_argument('--base', type=int, default=1000, help='Base seed to use')
    args = p.parse_args()

    path = args.scenarios
    if not os.path.exists(path):
        print('File not found:', path)
        return

    data = read_json(path)
    if not isinstance(data, list):
        print('Expected scenarios.json to be a list of scenarios')
        return

    # Backup
    ts = datetime.datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')
    bak = path + f'.bak.{ts}'
    shutil.copyfile(path, bak)
    print('Backup written to', bak)

    added = 0
    for i, s in enumerate(data):
        if not isinstance(s, dict):
            continue
        if 'seed' not in s:
            s['seed'] = args.base + i
            added += 1

    write_json(path, data)
    print(f'Added seeds to {added} scenarios (base {args.base}).')


if __name__ == '__main__':
    main()
