import subprocess
import os

def get_repo_root():
    try:
        repo_root = subprocess.check_output(
            ['git', 'rev-parse', '--show-toplevel'],
            stderr=subprocess.DEVNULL,
            text=True
        ).strip()
        return repo_root
    except subprocess.CalledProcessError:
        # Not in a git repo, fall back to current directory
        return os.getcwd()

def get_session_path():
    repo_root = get_repo_root()
    session_path = os.path.join(repo_root, "session")
    return session_path

def get_sqlite_db_path():
    repo_root = get_repo_root()
    db_path = os.path.join(repo_root, "bridge.db")
    return db_path

if __name__ == "__main__":
    _repo_root = get_repo_root()
    _session_path = os.path.join(_repo_root, "session")
    __session_path = get_session_path()
    assert _session_path == __session_path
    print(_session_path, os.path.exists(_session_path))
    
    sqlite_path = get_sqlite_db_path()
    print(sqlite_path, os.path.exists(sqlite_path))