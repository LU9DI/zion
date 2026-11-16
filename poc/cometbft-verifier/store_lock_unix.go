//go:build unix

package verifier

import (
	"errors"
	"os"
	"syscall"
)

// storeLock is an inter-process exclusive lock backed by the operating system,
// so it is released automatically if the holding process dies. The lock file is
// never removed: deleting a lock file while another process may be about to
// lock it reintroduces the race the lock exists to prevent.
type storeLock struct {
	file *os.File
}

func acquireStoreLock(path string) (*storeLock, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
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
	unlockErr := syscall.Flock(int(l.file.Fd()), syscall.LOCK_UN)
	closeErr := l.file.Close()
	l.file = nil
	if unlockErr != nil {
		return unlockErr
	}
	return closeErr
}
