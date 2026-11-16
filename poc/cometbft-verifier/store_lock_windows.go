//go:build windows

package verifier

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

// storeLock is an inter-process exclusive lock backed by a Windows byte-range
// lock, so it is released automatically if the holding process dies. The lock
// file is never removed: deleting a lock file while another process may be
// about to lock it reintroduces the race the lock exists to prevent.
type storeLock struct {
	file *os.File
}

func acquireStoreLock(path string) (*storeLock, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	overlapped := new(windows.Overlapped)
	err = windows.LockFileEx(
		windows.Handle(file.Fd()),
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY,
		0, 1, 0, overlapped,
	)
	if err != nil {
		_ = file.Close()
		if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
			return nil, ErrStoreLocked
		}
		return nil, err
	}
	return &storeLock{file: file}, nil
}

func (l *storeLock) release() error {
	if l == nil || l.file == nil {
		return nil
	}
	overlapped := new(windows.Overlapped)
	unlockErr := windows.UnlockFileEx(windows.Handle(l.file.Fd()), 0, 1, 0, overlapped)
	closeErr := l.file.Close()
	l.file = nil
	if unlockErr != nil {
		return unlockErr
	}
	return closeErr
}
