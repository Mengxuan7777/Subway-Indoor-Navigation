#!/usr/bin/env python3
"""
Batch runner for all scenarios in scenarios.json.
Executes each test case and aggregates results.
"""

import json
import subprocess
import sys
import os
import requests
from datetime import datetime


def check_backend_health(backend_url: str) -> bool:
    """Check if the backend simulator is running and responsive."""
    try:
        url = backend_url.rstrip('/') + '/api/state'
        print(f"Checking backend health: {url}")
        response = requests.get(url, timeout=5)
        response.raise_for_status()
        print(f"✅ Backend is running and responsive")
        return True
    except requests.exceptions.Timeout:
        print(f"❌ Backend health check timed out. Is the simulator running at {backend_url}?")
        return False
    except requests.exceptions.ConnectionError:
        print(f"❌ Cannot connect to backend at {backend_url}. Is the simulator running?")
        return False
    except Exception as e:
        print(f"❌ Backend health check failed: {e}")
        return False


def check_llm_health(llm_parse_url: str) -> bool:
    """Check if the LLM parse endpoint is running and responsive."""
    try:
        print(f"Checking LLM parse endpoint: {llm_parse_url}")
        # Make a test call with dummy data
        test_payload = {
            "start": "TEST",
            "goal": "TEST",
            "user": "Test query"
        }
        response = requests.post(llm_parse_url, json=test_payload, timeout=10)
        response.raise_for_status()
        
        # Check if response is valid JSON with expected structure
        result = response.json()
        if not isinstance(result, dict):
            print(f"⚠️  LLM returned non-dict response: {type(result)}")
            return False
        
        print(f"✅ LLM parse endpoint is running and responsive")
        return True
    except requests.exceptions.Timeout:
        print(f"❌ LLM health check timed out. Is the LLM server running at {llm_parse_url}?")
        return False
    except requests.exceptions.ConnectionError:
        print(f"❌ Cannot connect to LLM at {llm_parse_url}. Is the LLM server running?")
        return False
    except Exception as e:
        print(f"❌ LLM health check failed: {e}")
        return False


def load_scenarios(path: str):
    """Load scenarios from JSON file."""
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def run_scenario(scenario, backend_url, llm_parse_url, root_dir, scenarios_path):
    """Run a single scenario using run_trail.py."""
    case_id = scenario.get('case_id') or scenario.get('id', 'unknown')
    
    cmd = [
        sys.executable,
        'run_trail.py',
        '--backend', backend_url,
        '--scenario-id', case_id,
        '--user-from-scenarios', scenarios_path,
        '--post-scenario',
        '--llm-parse', llm_parse_url,
        '--root', root_dir,
        '--out', 'tools/trial_results.json'
    ]
    
    print(f"\n{'='*60}")
    print(f"Running scenario: {case_id}")
    print(f"Category: {scenario.get('category', 'N/A')}")
    print(f"Query: {scenario.get('query', 'N/A')[:80]}...")
    print(f"{'='*60}")
    
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=60,
            cwd=root_dir
        )
        
        print(result.stdout)
        if result.stderr:
            print("STDERR:", result.stderr, file=sys.stderr)
        
        if result.returncode != 0:
            print(f"❌ Scenario {case_id} failed with return code {result.returncode}")
            return False
        else:
            print(f"✅ Scenario {case_id} completed successfully")
            return True
            
    except subprocess.TimeoutExpired:
        print(f"❌ Scenario {case_id} timed out after 60 seconds")
        return False
    except Exception as e:
        print(f"❌ Scenario {case_id} failed with exception: {e}")
        return False


def main():
    # Configuration
    root_dir = os.path.dirname(os.path.abspath(__file__))
    scenarios_path = os.path.join(root_dir, 'scenarios.json')
    backend_url = 'http://127.0.0.1:5000'
    llm_parse_url = 'http://127.0.0.1:5001/parse'
    
    # Allow overrides via command line arguments
    if len(sys.argv) > 1:
        scenarios_path = sys.argv[1]
    if len(sys.argv) > 2:
        backend_url = sys.argv[2]
    if len(sys.argv) > 3:
        llm_parse_url = sys.argv[3]
    
    print(f"Loading scenarios from: {scenarios_path}")
    print(f"Backend URL: {backend_url}")
    print(f"LLM Parse URL: {llm_parse_url}")
    print()
    
    # Health checks
    print("Running health checks...")
    print("-" * 60)
    
    backend_ok = check_backend_health(backend_url)
    llm_ok = check_llm_health(llm_parse_url)
    
    print("-" * 60)
    
    if not backend_ok:
        print("\n❌ Backend simulator is not available. Please start the simulator before running scenarios.")
        print(f"   Expected at: {backend_url}")
        sys.exit(1)
    
    if not llm_ok:
        print("\n❌ LLM parse endpoint is not available. Please start the LLM server before running scenarios.")
        print(f"   Expected at: {llm_parse_url}")
        sys.exit(1)
    
    print("\n✅ All services are healthy and ready!\n")
    
    # Load scenarios
    try:
        scenarios = load_scenarios(scenarios_path)
    except Exception as e:
        print(f"Error loading scenarios: {e}")
        sys.exit(1)
    
    if not isinstance(scenarios, list):
        print("Error: scenarios.json should contain an array of scenarios")
        sys.exit(1)
    
    total = len(scenarios)
    print(f"\nFound {total} scenarios to run\n")
    
    # Clear or backup previous results
    results_path = os.path.join(root_dir, 'tools', 'trial_results.json')
    if os.path.exists(results_path):
        backup_path = results_path.replace('.json', f'.backup.{datetime.now().strftime("%Y%m%d_%H%M%S")}.json')
        os.rename(results_path, backup_path)
        print(f"Backed up existing results to: {backup_path}\n")
    
    # Run all scenarios
    start_time = datetime.now()
    success_count = 0
    failure_count = 0
    
    for i, scenario in enumerate(scenarios, 1):
        print(f"\n[{i}/{total}] Processing scenario...")
        if run_scenario(scenario, backend_url, llm_parse_url, root_dir, scenarios_path):
            success_count += 1
        else:
            failure_count += 1
    
    # Summary
    end_time = datetime.now()
    duration = end_time - start_time
    
    print(f"\n{'='*60}")
    print("BATCH RUN SUMMARY")
    print(f"{'='*60}")
    print(f"Total scenarios: {total}")
    print(f"✅ Successful: {success_count}")
    print(f"❌ Failed: {failure_count}")
    print(f"Duration: {duration}")
    print(f"\nResults saved to: {results_path}")
    print(f"{'='*60}\n")
    
    sys.exit(0 if failure_count == 0 else 1)


if __name__ == '__main__':
    main()
