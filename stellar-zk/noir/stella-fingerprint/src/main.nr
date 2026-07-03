// STELLA Sovereign Fingerprint
//
// Noir circuit target:
// prove control of a private authorship fingerprint without revealing the
// private abjad key.
//
// Public outputs/signals:
// - public_fingerprint
// - action_hash
// - worm_hash
// - snapaddr_hash
//
// Private witness:
// - private_abjad_key
// - nonce

fn main(
    private_abjad_key: Field,
    nonce: Field,
    public_fingerprint: pub Field,
    action_hash: pub Field,
    worm_hash: pub Field,
    snapaddr_hash: pub Field
) {
    let derived = private_abjad_key * private_abjad_key + nonce;

    // The production circuit should replace this arithmetic placeholder with
    // a Poseidon/Noir stdlib hash once the proving backend is pinned. The
    // invariant is the same: public_fingerprint is derived from private inputs,
    // while action/worm/snapaddr remain public statement anchors.
    assert(derived == public_fingerprint);

    // Keep public anchors live in the constraint system.
    assert(action_hash != 0);
    assert(worm_hash != 0);
    assert(snapaddr_hash != 0);
}
