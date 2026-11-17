//! Exact-size snapshots for already bounded, regular artifact files.
//!
//! The caller validates the metadata limit and checks identity/metadata around
//! the read. A growing file must not grow its Vec beyond that admitted length.

use std::io::{self, Read};

pub(crate) fn read_exact_snapshot(reader: &mut impl Read, length: usize) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(length)
        .map_err(|_| io::Error::other("artifact snapshot allocation failed"))?;
    bytes.resize(length, 0);
    reader.read_exact(&mut bytes)?;
    // Probe on the stack rather than extending the full Vec with an extra byte.
    // read_exact handles Interrupted; the EOF probe must do the same.
    let mut probe = [0];
    loop {
        match reader.read(&mut probe) {
            Ok(0) => return Ok(bytes),
            Ok(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "artifact file grew while reading",
                ));
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn exact_snapshot_accepts_empty_and_exact_bytes() {
        assert!(read_exact_snapshot(&mut Cursor::new([]), 0)
            .unwrap()
            .is_empty());
        assert_eq!(
            read_exact_snapshot(&mut Cursor::new(b"bytes"), 5).unwrap(),
            b"bytes"
        );
    }

    #[test]
    fn changed_length_is_rejected_after_at_most_one_probe_byte() {
        let mut growing = Cursor::new(b"more than admitted");
        assert_eq!(
            read_exact_snapshot(&mut growing, 4).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(growing.position(), 5);
        assert_eq!(
            read_exact_snapshot(&mut Cursor::new(b"short"), 6)
                .unwrap_err()
                .kind(),
            io::ErrorKind::UnexpectedEof
        );
        let mut nonempty = Cursor::new(b"x");
        assert_eq!(
            read_exact_snapshot(&mut nonempty, 0).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(nonempty.position(), 1);
    }

    #[test]
    fn eof_probe_retries_interruption_and_preserves_other_io_errors() {
        struct Probe {
            interrupted: bool,
            final_error: Option<io::ErrorKind>,
        }
        impl Read for Probe {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                if !self.interrupted {
                    self.interrupted = true;
                    return Err(io::ErrorKind::Interrupted.into());
                }
                match self.final_error {
                    Some(kind) => Err(kind.into()),
                    None => Ok(0),
                }
            }
        }
        assert!(read_exact_snapshot(
            &mut Probe {
                interrupted: false,
                final_error: None,
            },
            0,
        )
        .unwrap()
        .is_empty());
        assert_eq!(
            read_exact_snapshot(
                &mut Probe {
                    interrupted: false,
                    final_error: Some(io::ErrorKind::PermissionDenied),
                },
                0,
            )
            .unwrap_err()
            .kind(),
            io::ErrorKind::PermissionDenied
        );
    }

    #[test]
    fn impossible_capacity_returns_an_error_instead_of_panicking() {
        assert!(read_exact_snapshot(&mut Cursor::new([]), usize::MAX).is_err());
    }
}
