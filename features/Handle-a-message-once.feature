Feature: Handle a message once
  As a service owner
  I want a message delivered more than once to change the data once
  So that a broker that delivers at least once does not repeat the side effects of a handler

  Scenario: The record is stored with the Firestore side effects
    Given a message that a handler has not handled yet
    When the handler stores its side effects in Firestore
    Then the side effects and the record of the message are stored in the same transaction
    And the record is done

  Scenario: A message delivered again is not handled again
    Given a message that a handler has already handled
    When the message is delivered again
    Then the handler does not store its side effects again
    And the result says the message is a duplicate

  Scenario: Nothing is stored when the Firestore side effects fail
    Given a message that a handler has not handled yet
    When the transaction of its side effects fails
    Then no record of the message is stored
    And a later delivery handles the message

  Scenario: Two deliveries of the same message at the same time
    Given two deliveries of the same message handled at the same time
    When both store their side effects
    Then only one of them stores its side effects
    And the other one fails as busy, so the message is delivered again later

  Scenario: Each handler of a message has its own record
    Given two handlers of the same message
    When both handle it
    Then each handler has its own record of the message

  Scenario: Side effects that forget the record
    Given Firestore side effects that do not write the record of the message
    When the handler handles the message
    Then the record is written on its own
    And a warning is logged
