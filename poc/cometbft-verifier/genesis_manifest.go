package verifier

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"sort"
	"unicode/utf8"

	"github.com/cometbft/cometbft/types"
)

// This file implements the two parts of the genesis bootstrap that do not depend
// on decisions the project has deliberately not made: a canonical genesis
// manifest encoding, and verification of multi-governor signatures over that
// manifest under a caller-supplied acceptance policy.
//
// It deliberately does not conduct a ceremony, choose governors, choose a
// threshold, select a validator set, a DKG construction or a consensus engine.
// The governor list, the manifest threshold, the acceptance policy, and the
// opaque policy digests are all caller-supplied inputs. A verified signature set
// proves only that the listed keys signed the exact manifest bytes; it proves
// nothing about operator independence, coercion or collusion.

const (
	genesisManifestMagic   = "ZGN1"
	genesisSchemaVersion   = uint16(1)
	genesisEncodingVersion = uint16(1)
	genesisDigestDomain    = "ZION-POC-GENESIS-MANIFEST-v1\x00"
	// MaxGenesisGovernors is an implementation resource bound, not a governance
	// parameter. A larger candidate set must be rejected rather than accepted
	// with silently reduced verification work.
	MaxGenesisGovernors = 128
	genesisFixedBytes   = 4 + 2 + 2 + 4 + 2 + walDigestSize + 2 + 8 +
		walDigestSize*3 + 2 + 2 + walDigestSize
)

var (
	ErrGenesisManifestInvalid    = errors.New("invalid canonical genesis manifest")
	ErrGenesisManifestBounds     = errors.New("genesis manifest exceeds configured bounds")
	ErrGenesisChecksum           = errors.New("genesis manifest checksum mismatch")
	ErrGenesisDuplicateGovernor  = errors.New("genesis manifest contains a duplicate governor key")
	ErrGenesisThreshold          = errors.New("genesis governor threshold is invalid or unmet")
	ErrGenesisDuplicateSigner    = errors.New("duplicate governor signature")
	ErrGenesisUnauthorizedSigner = errors.New("signature from a key that is not an accepted genesis governor")
	ErrGenesisSignature          = errors.New("invalid genesis governor signature")
	ErrGenesisConflict           = errors.New("conflicting genesis manifest for the same project")
)

// GenesisGovernor is one initial authority. ControlDomainDigest is the caller's
// declaration about the operator/control domain behind the key: it records the
// claim so concentration is auditable, and is not evidence of independence.
type GenesisGovernor struct {
	PublicKey           [ed25519.PublicKeySize]byte
	ControlDomainDigest [walDigestSize]byte
}

// GenesisManifest is the canonical, versioned bootstrap record. Policy content
// that the project has not decided yet is bound by digest rather than invented
// here.
type GenesisManifest struct {
	ProjectID            string
	ChainID              string
	GenesisNonce         [walDigestSize]byte
	InitialHeight        uint64
	AppGenesisDigest     [walDigestSize]byte
	GovernorPolicyDigest [walDigestSize]byte
	RecoveryPolicyDigest [walDigestSize]byte
	Governors            []GenesisGovernor
	Threshold            uint16
}

// GenesisSignature is one governor signature over the canonical manifest digest.
type GenesisSignature struct {
	PublicKey [ed25519.PublicKeySize]byte
	Signature [ed25519.SignatureSize]byte
}

// GenesisAcceptancePolicy is the caller's trust decision. RequiredSignatures
// must be stated explicitly and may not be lower than the manifest threshold.
// AuthorizedKeys, when non-empty, restricts which governor keys are accepted;
// it must itself come from an independently authenticated source.
type GenesisAcceptancePolicy struct {
	RequiredSignatures uint64
	AuthorizedKeys     [][ed25519.PublicKeySize]byte
}

// AcceptedGenesis is the result of a successful acceptance check. It is the
// object a node retains and later compares against any manifest it is offered.
type AcceptedGenesis struct {
	ProjectID        string
	ChainID          string
	InitialHeight    uint64
	AppGenesisDigest [walDigestSize]byte
	ManifestDigest   [walDigestSize]byte
	Signers          []int
}

// EncodeGenesisManifest emits the canonical ZGN1 v1 encoding.
func EncodeGenesisManifest(manifest GenesisManifest) ([]byte, error) {
	if err := validateGenesisManifest(manifest); err != nil {
		return nil, err
	}
	project := []byte(manifest.ProjectID)
	chainID := []byte(manifest.ChainID)
	total := genesisFixedBytes + len(project) + len(chainID) +
		len(manifest.Governors)*(ed25519.PublicKeySize+walDigestSize)
	out := make([]byte, 0, total)
	out = append(out, genesisManifestMagic...)
	out = appendUint16(out, genesisSchemaVersion)
	out = appendUint16(out, genesisEncodingVersion)
	out = appendUint32(out, uint32(total))
	out = appendUint16(out, uint16(len(project)))
	out = append(out, project...)
	out = append(out, manifest.GenesisNonce[:]...)
	out = appendUint16(out, uint16(len(chainID)))
	out = append(out, chainID...)
	out = appendUint64(out, manifest.InitialHeight)
	out = append(out, manifest.AppGenesisDigest[:]...)
	out = append(out, manifest.GovernorPolicyDigest[:]...)
	out = append(out, manifest.RecoveryPolicyDigest[:]...)
	out = appendUint16(out, uint16(len(manifest.Governors)))
	for _, governor := range manifest.Governors {
		out = append(out, governor.PublicKey[:]...)
		out = append(out, governor.ControlDomainDigest[:]...)
	}
	out = appendUint16(out, manifest.Threshold)
	if len(out) != total-walDigestSize {
		return nil, ErrGenesisManifestInvalid
	}
	checksum := sha256.Sum256(out)
	out = append(out, checksum[:]...)
	return out, nil
}

// DecodeGenesisManifest strictly decodes one canonical ZGN1 v1 manifest.
func DecodeGenesisManifest(raw []byte) (GenesisManifest, error) {
	var manifest GenesisManifest
	if len(raw) < genesisFixedBytes+1 {
		return manifest, ErrGenesisManifestInvalid
	}
	if len(raw) > genesisFixedBytes+maxProjectIDBytes+types.MaxChainIDLen+
		MaxGenesisGovernors*2*walDigestSize {
		return manifest, ErrGenesisManifestBounds
	}
	if string(raw[:4]) != genesisManifestMagic {
		return manifest, ErrGenesisManifestInvalid
	}
	if binary.BigEndian.Uint16(raw[4:6]) != genesisSchemaVersion ||
		binary.BigEndian.Uint16(raw[6:8]) != genesisEncodingVersion {
		return manifest, ErrGenesisManifestInvalid
	}
	if uint64(binary.BigEndian.Uint32(raw[8:12])) != uint64(len(raw)) {
		return manifest, ErrGenesisManifestInvalid
	}
	checksumOffset := len(raw) - walDigestSize
	expected := sha256.Sum256(raw[:checksumOffset])
	if !bytes.Equal(expected[:], raw[checksumOffset:]) {
		return manifest, ErrGenesisChecksum
	}
	offset := 12
	readBytes := func(n int) ([]byte, error) {
		if n < 0 || checksumOffset-offset < n {
			return nil, ErrGenesisManifestInvalid
		}
		value := raw[offset : offset+n]
		offset += n
		return value, nil
	}
	readUint16 := func() (uint16, error) {
		value, err := readBytes(2)
		if err != nil {
			return 0, err
		}
		return binary.BigEndian.Uint16(value), nil
	}

	projectLength, err := readUint16()
	if err != nil || projectLength == 0 || projectLength > maxProjectIDBytes {
		return manifest, ErrGenesisManifestInvalid
	}
	project, err := readBytes(int(projectLength))
	if err != nil || !utf8.Valid(project) || bytes.IndexByte(project, 0) >= 0 {
		return manifest, ErrGenesisManifestInvalid
	}
	manifest.ProjectID = string(project)
	nonce, err := readBytes(walDigestSize)
	if err != nil {
		return manifest, err
	}
	copy(manifest.GenesisNonce[:], nonce)
	chainIDLength, err := readUint16()
	if err != nil || chainIDLength == 0 || chainIDLength > types.MaxChainIDLen {
		return manifest, ErrGenesisManifestInvalid
	}
	chainID, err := readBytes(int(chainIDLength))
	if err != nil || !utf8.Valid(chainID) || bytes.IndexByte(chainID, 0) >= 0 {
		return manifest, ErrGenesisManifestInvalid
	}
	manifest.ChainID = string(chainID)
	heightBytes, err := readBytes(8)
	if err != nil {
		return manifest, err
	}
	manifest.InitialHeight = binary.BigEndian.Uint64(heightBytes)
	for _, target := range [][]byte{
		manifest.AppGenesisDigest[:],
		manifest.GovernorPolicyDigest[:],
		manifest.RecoveryPolicyDigest[:],
	} {
		value, err := readBytes(walDigestSize)
		if err != nil {
			return manifest, err
		}
		copy(target, value)
	}
	governorCount, err := readUint16()
	if err != nil || governorCount == 0 || governorCount > MaxGenesisGovernors {
		return manifest, ErrGenesisManifestBounds
	}
	if uint64(governorCount)*2*walDigestSize > uint64(checksumOffset-offset) {
		return manifest, ErrGenesisManifestInvalid
	}
	manifest.Governors = make([]GenesisGovernor, governorCount)
	for i := uint16(0); i < governorCount; i++ {
		key, err := readBytes(ed25519.PublicKeySize)
		if err != nil {
			return manifest, err
		}
		copy(manifest.Governors[i].PublicKey[:], key)
		domain, err := readBytes(walDigestSize)
		if err != nil {
			return manifest, err
		}
		copy(manifest.Governors[i].ControlDomainDigest[:], domain)
	}
	threshold, err := readUint16()
	if err != nil {
		return manifest, err
	}
	manifest.Threshold = threshold
	if offset != checksumOffset {
		return manifest, ErrGenesisManifestInvalid
	}
	if err := validateGenesisManifest(manifest); err != nil {
		return manifest, err
	}
	return manifest, nil
}

// GenesisManifestDigest returns the domain-separated digest that governors sign.
func GenesisManifestDigest(manifest GenesisManifest) ([walDigestSize]byte, error) {
	encoded, err := EncodeGenesisManifest(manifest)
	if err != nil {
		return [walDigestSize]byte{}, err
	}
	return genesisDigestOf(encoded), nil
}

func genesisDigestOf(encoded []byte) [walDigestSize]byte {
	var buffer bytes.Buffer
	buffer.WriteString(genesisDigestDomain)
	buffer.Write(encoded)
	return sha256.Sum256(buffer.Bytes())
}

func validateGenesisManifest(manifest GenesisManifest) error {
	project := []byte(manifest.ProjectID)
	chainID := []byte(manifest.ChainID)
	if len(project) == 0 || len(project) > maxProjectIDBytes ||
		!utf8.Valid(project) || bytes.IndexByte(project, 0) >= 0 ||
		len(chainID) == 0 || len(chainID) > types.MaxChainIDLen ||
		!utf8.Valid(chainID) || bytes.IndexByte(chainID, 0) >= 0 {
		return ErrGenesisManifestInvalid
	}
	if isZeroDigestBytes(manifest.GenesisNonce[:]) ||
		isZeroDigestBytes(manifest.AppGenesisDigest[:]) ||
		isZeroDigestBytes(manifest.GovernorPolicyDigest[:]) ||
		isZeroDigestBytes(manifest.RecoveryPolicyDigest[:]) {
		return ErrGenesisManifestInvalid
	}
	if len(manifest.Governors) == 0 {
		return ErrGenesisManifestInvalid
	}
	if len(manifest.Governors) > MaxGenesisGovernors {
		return ErrGenesisManifestBounds
	}
	seen := make(map[[ed25519.PublicKeySize]byte]bool, len(manifest.Governors))
	for _, governor := range manifest.Governors {
		if isZeroDigestBytes(governor.PublicKey[:]) ||
			isZeroDigestBytes(governor.ControlDomainDigest[:]) {
			return ErrGenesisManifestInvalid
		}
		if seen[governor.PublicKey] {
			return ErrGenesisDuplicateGovernor
		}
		seen[governor.PublicKey] = true
	}
	if manifest.Threshold == 0 || int(manifest.Threshold) > len(manifest.Governors) {
		return ErrGenesisThreshold
	}
	return nil
}

// SignGenesisManifest produces one governor signature over the canonical digest.
// It exists so tests and future ceremony tooling can produce evidence; it is not
// a keystore and holds no key material.
func SignGenesisManifest(manifest GenesisManifest, privateKey ed25519.PrivateKey) (GenesisSignature, error) {
	digest, err := GenesisManifestDigest(manifest)
	if err != nil {
		return GenesisSignature{}, err
	}
	var signature GenesisSignature
	publicKey, ok := privateKey.Public().(ed25519.PublicKey)
	if !ok || len(publicKey) != ed25519.PublicKeySize {
		return signature, ErrGenesisSignature
	}
	copy(signature.PublicKey[:], publicKey)
	copy(signature.Signature[:], ed25519.Sign(privateKey, digest[:]))
	return signature, nil
}

// VerifyGenesisAcceptance verifies distinct governor signatures over the exact
// canonical manifest digest under the caller's policy. It fails closed: unknown
// keys, duplicate signers, invalid signatures and unstated thresholds are errors,
// never silently skipped.
func VerifyGenesisAcceptance(manifest GenesisManifest, signatures []GenesisSignature, policy GenesisAcceptancePolicy) (AcceptedGenesis, error) {
	var accepted AcceptedGenesis
	encoded, err := EncodeGenesisManifest(manifest)
	if err != nil {
		return accepted, err
	}
	digest := genesisDigestOf(encoded)
	if policy.RequiredSignatures == 0 {
		// The acceptance threshold is a project decision and must be stated by
		// the caller; the manifest threshold is a floor, not a default.
		return accepted, fmt.Errorf("%w: acceptance policy did not state a required signature count", ErrGenesisThreshold)
	}
	if policy.RequiredSignatures < uint64(manifest.Threshold) {
		return accepted, fmt.Errorf("%w: policy threshold %d is below the manifest threshold %d",
			ErrGenesisThreshold, policy.RequiredSignatures, manifest.Threshold)
	}
	if policy.RequiredSignatures > uint64(len(manifest.Governors)) {
		return accepted, fmt.Errorf("%w: policy requires %d signatures but only %d governors exist",
			ErrGenesisThreshold, policy.RequiredSignatures, len(manifest.Governors))
	}
	authorized := make(map[[ed25519.PublicKeySize]byte]bool, len(policy.AuthorizedKeys))
	for _, key := range policy.AuthorizedKeys {
		authorized[key] = true
	}
	index := make(map[[ed25519.PublicKeySize]byte]int, len(manifest.Governors))
	for i, governor := range manifest.Governors {
		index[governor.PublicKey] = i
	}
	signed := make(map[int]bool, len(signatures))
	for _, signature := range signatures {
		governorIndex, ok := index[signature.PublicKey]
		if !ok {
			return accepted, ErrGenesisUnauthorizedSigner
		}
		if len(policy.AuthorizedKeys) > 0 && !authorized[signature.PublicKey] {
			return accepted, ErrGenesisUnauthorizedSigner
		}
		if signed[governorIndex] {
			return accepted, ErrGenesisDuplicateSigner
		}
		if !ed25519.Verify(ed25519.PublicKey(signature.PublicKey[:]), digest[:], signature.Signature[:]) {
			return accepted, ErrGenesisSignature
		}
		signed[governorIndex] = true
	}
	if uint64(len(signed)) < policy.RequiredSignatures {
		return accepted, fmt.Errorf("%w: %d distinct valid signatures, required %d",
			ErrGenesisThreshold, len(signed), policy.RequiredSignatures)
	}
	signers := make([]int, 0, len(signed))
	for governorIndex := range signed {
		signers = append(signers, governorIndex)
	}
	sort.Ints(signers)
	accepted = AcceptedGenesis{
		ProjectID:        manifest.ProjectID,
		ChainID:          manifest.ChainID,
		InitialHeight:    manifest.InitialHeight,
		AppGenesisDigest: manifest.AppGenesisDigest,
		ManifestDigest:   digest,
		Signers:          signers,
	}
	return accepted, nil
}

// CheckGenesisAnchor fails closed when a retained acceptance does not describe
// the same project genesis as the manifest being presented. A different manifest
// for the same project is a conflict, never a replacement.
func CheckGenesisAnchor(retained AcceptedGenesis, manifest GenesisManifest) error {
	digest, err := GenesisManifestDigest(manifest)
	if err != nil {
		return err
	}
	if retained.ProjectID != manifest.ProjectID {
		return fmt.Errorf("%w: retained anchor is for project %q", ErrGenesisConflict, retained.ProjectID)
	}
	if retained.ManifestDigest != digest {
		return fmt.Errorf("%w: presented manifest digest differs from the retained anchor", ErrGenesisConflict)
	}
	if retained.ChainID != manifest.ChainID ||
		retained.InitialHeight != manifest.InitialHeight ||
		retained.AppGenesisDigest != manifest.AppGenesisDigest {
		return fmt.Errorf("%w: presented manifest context differs from the retained anchor", ErrGenesisConflict)
	}
	return nil
}
