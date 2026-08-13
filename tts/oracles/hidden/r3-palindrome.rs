use palindrome::is_palindrome;

#[test]
fn plain() {
    assert!(is_palindrome("level"));
}

#[test]
fn mixed_case_spaces() {
    assert!(is_palindrome("A man a plan a canal Panama"));
}

#[test]
fn unicode() {
    assert!(is_palindrome("А роза упала на лапу Азора"));
}

#[test]
fn negative() {
    assert!(!is_palindrome("rust"));
}
