use bugfix::median;
#[test]
fn even_len() { assert_eq!(median(&mut vec![1, 2, 3, 4]), 2.5); }
#[test]
fn odd_len()  { assert_eq!(median(&mut vec![5, 1, 3]), 3.0); }
