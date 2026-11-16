//go:build !unix && !windows

package verifier

import "errors"

var errStoreLockUnsupported = errors.New("store locking is not implemented for this platform")

type storeLock struct{}

func acquireStoreLock(string) (*storeLock, error) { return nil, errStoreLockUnsupported }

func (l *storeLock) release() error { return nil }
