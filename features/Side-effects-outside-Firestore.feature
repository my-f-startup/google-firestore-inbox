Feature: Side effects outside Firestore
  As a service owner
  I want each side effect outside Firestore to behave as its class declares when a handling is interrupted
  So that an effect is never repeated when it must not be, and a failure is never hidden

  Background:
    Given the record of a message is processing while its side effects outside Firestore run

  Scenario: The record is done after the external effects
    When every external effect of the handler succeeds
    Then the record is done
    And it lists the effects that completed

  Scenario: A delivery during the lease waits
    Given a handling that was interrupted less than the lease ago
    When the message is delivered again
    Then the delivery fails as busy
    And no side effect runs

  Scenario: A repeatable effect runs again after an interruption
    Given an interrupted repeatable effect, older than the lease
    When the message is delivered again
    Then the effect runs again
    And the Firestore side effects are not stored again

  Scenario: A keyed effect runs again with the same key
    Given an interrupted keyed effect, older than the lease
    When the message is delivered again
    Then the effect runs again with the same idempotency key

  Scenario: A checkable effect is checked before it runs again
    Given an interrupted checkable effect that already happened
    When the message is delivered again
    Then the effect does not run again
    And the record is done

  Scenario: A checkable effect that did not happen runs again
    Given an interrupted checkable effect that did not happen
    When the message is delivered again
    Then the effect runs again

  Scenario: An interrupted unverifiable effect is not run again
    Given an interrupted unverifiable effect, older than the lease
    When the message is delivered again
    Then the effect does not run again
    And the delivery fails, so the message ends in the dead letter topic
    And the record stays processing for a person to decide

  Scenario: Only the first pending effect can have been interrupted
    Given an interrupted effect followed by an unverifiable effect
    When the message is delivered again
    Then the unverifiable effect runs, since it had not started

  Scenario: A completed effect is not run again
    Given an effect that completed before another one was interrupted
    When the message is delivered again
    Then the completed effect does not run again

  Scenario: A handling longer than the lease keeps it
    Given an effect that takes longer than the lease
    When the message is delivered again while the effect runs
    Then the delivery fails as busy, because the lease was renewed
    And the effect runs once

  Scenario: A delivery whose lease was taken over stops
    Given another delivery took the message over while an effect ran
    When the first delivery finishes the effect
    Then it does not write the record
    And it fails, so the other delivery stays the owner

  Scenario: A handling that stops renewing loses the lease
    Given a handling that stopped before its effects completed
    When the message is delivered again after one lease
    Then the new delivery takes the record over and resumes it

  Scenario: A person removes the record to run the message again
    Given the record of an interrupted unverifiable effect
    When a person removes the record
    Then the next delivery handles the message from the start
