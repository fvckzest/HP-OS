# HP-OS events and ticketing language

This glossary names the first-release business concepts. The [ownership decision](https://github.com/fvckzest/HP-OS/issues/3#issuecomment-5848567711), [first-release jobs decision](https://github.com/fvckzest/HP-OS/issues/6#issuecomment-5848947118), [domain-language decision](https://github.com/fvckzest/HP-OS/issues/7#issuecomment-5848989424), and [ticketing journey](https://github.com/fvckzest/HP-OS/issues/8) provide the decision history.

## Language

**Customer organization**:
The customer that owns one or more Sites and is the seller for ticket sales through those Sites.
_Avoid_: Customer, account

**Site**:
An organization-owned public and staff-facing experience, such as LMNL, that owns its own events, buyers, orders, tickets, and admission records.
_Avoid_: Organization, website account

**Event**:
A Site-owned occasion for which admission may be sold.
_Avoid_: Ticket offering, Square item

**Ticket offering**:
The priced admission option for an Event, including the quantity available for sale; an Event has exactly one in the first release.
_Avoid_: Event, ticket, Square catalog item

**Buyer**:
The Site-specific record of a person who places Orders, associated across purchases by purchase email within that Site; one Buyer may place Orders for several Events on the same Site.
_Avoid_: Ticket holder, attendee, customer organization

**Order**:
A Site-owned record of a Buyer's attempt to purchase one or more Tickets for one Event, beginning when checkout starts and retaining the buyer name and email used for that purchase.
_Avoid_: Access Request, payment, ticket

**Reservation**:
A temporary claim on a Ticket offering's available quantity while an Order is in checkout; it releases that quantity if checkout ends without payment.
_Avoid_: Ticket, sale, admission

**Ticket**:
An individual right to one admission to an Event, issued from a paid Order and independently presentable at the door.
_Avoid_: Order, ticket offering, QR code

**Admission**:
The recorded successful entry using one Ticket; a rejected or repeated scan is not another Admission.
_Avoid_: Ticket, scan attempt

**Access Request**:
A private-Event guest's request for staff permission to begin paid checkout.
_Avoid_: Order, public checkout attempt

## Relationships

- One **Customer organization** owns one or more **Sites**; each Site belongs to exactly one organization.
- Each **Site** owns its **Events**, **Buyers**, **Orders**, **Tickets**, and **Admissions**. Records are not shared between Sites, even when they share a payment connection.
- An **Event** has exactly one **Ticket offering** in the first release. Its **Orders** and **Tickets** belong to that same Event and Site.
- An **Order** belongs to one **Buyer** and one **Event**. It may have no issued Tickets before payment; a paid Order can issue one or more independently usable Tickets. Public checkout may sell multiple Tickets, while an approved private Access Request initially permits one.
- An **Order** holds a **Reservation** for its requested quantity during checkout. The Reservation prevents another checkout from claiming the same capacity and releases its claim if checkout ends without payment. It is not an issued Ticket.
- A **Ticket** belongs to exactly one **Order** and its Event's **Ticket offering**. It may have zero or one successful **Admission**.
- A **Buyer** is not automatically the person who uses every Ticket in the Buyer's Order. Public checkout does not require individual attendee names and emails. Private **Access Requests** require the intended attendee's name and email for approval, and each resulting **Ticket** retains that approved attendee association; the purchaser's identity is collected separately at checkout. This supports private attendee vetting, as decided in [ticket #10](https://github.com/fvckzest/HP-OS/issues/10).
- Orders with the same purchase email on one Site are associated with one **Buyer**, while each Order retains the name and email entered for that purchase. A verified delivery-address correction re-associates the Order with the Buyer record for the corrected email on that Site. The same email on another Site does not join the records.
- A private **Access Request** is separate from an **Order**. An approved request permits checkout, which begins an Order.
- Multiple independent private **Access Requests** for one Event may use identical attendee names and emails. Each requires its own approval and permits one paid Ticket. There is no attendee-name or email uniqueness restriction per Event; this keeps repeated requests simple, as decided in [ticket #10](https://github.com/fvckzest/HP-OS/issues/10).
