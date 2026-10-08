# HP-OS domain language

This glossary names the shared domain concepts. The [ownership decision](https://github.com/fvckzest/HP-OS/issues/3#issuecomment-5848567711), [first-release jobs decision](https://github.com/fvckzest/HP-OS/issues/6#issuecomment-5848947118), [domain-language decision](https://github.com/fvckzest/HP-OS/issues/7#issuecomment-5848989424), [ticketing journey](https://github.com/fvckzest/HP-OS/issues/8), and [portfolio decisions](https://github.com/fvckzest/HP-OS/issues/110) provide the decision history.

## Language

**Customer organization**:
The customer that owns one or more Sites and is the seller for ticket sales through those Sites.
_Avoid_: Customer, account

**Site**:
An organization-owned public and staff-facing experience, such as LMNL, that owns its own events, buyers, orders, tickets, and admission records.
_Avoid_: Organization, website account

**Artwork**:
A Site-scoped creative work record with stable API identity, a displayed Artwork ID, public metadata, and an independent original-sale status.
_Avoid_: Photo, print listing

**Collection**:
A named, ordered group of Artworks used for public browsing. One Artwork may belong to multiple Collections; inactive Collections keep their memberships but are hidden publicly.
_Avoid_: Artwork category field

**Photo**:
A Site-scoped image resource attached to an Artwork, with a stable ID and `processing`, `ready`, or `failed` delivery state. A ready Photo has 400 px and 1,600 px WebP variants; its source is not retained as an HP-OS master.
_Avoid_: Private master, print edition

**Hero Photo**:
The one ready Photo selected to represent an Artwork as its primary image.
_Avoid_: first Photo, collection thumbnail

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
- Each **Site** owns its **Artworks**, **Collections**, and **Photos**. An **Artwork** may have multiple **Photos** and belong to multiple **Collections**. Publication requires at least one active Collection, all Photos ready at both delivery sizes, and one ready **Hero Photo**.
- A **Photo** keeps its stable identity, order, hero selection, and public delivery references when its images are replaced. Replacement bytes become current only after both WebP variants are ready; an existing published Artwork continues serving its old ready variants if replacement fails.
- An **Event** has exactly one **Ticket offering** in the first release. Its **Orders** and **Tickets** belong to that same Event and Site.
- An **Order** belongs to one **Buyer** and one **Event**. It may have no issued Tickets before payment; a paid Order can issue one or more independently usable Tickets. Public checkout may sell multiple Tickets, while an approved private Access Request initially permits one.
- An **Order** holds a **Reservation** for its requested quantity during checkout. The Reservation prevents another checkout from claiming the same capacity and releases its claim if checkout ends without payment. It is not an issued Ticket.
- A **Ticket** belongs to exactly one **Order** and its Event's **Ticket offering**. It may have zero or one successful **Admission**.
- A **Buyer** is not automatically the person who uses every Ticket in the Buyer's Order. Public checkout does not require individual attendee names and emails. Private **Access Requests** require the intended attendee's name and email for approval, and each resulting **Ticket** retains that approved attendee association; the purchaser's identity is collected separately at checkout. This supports private attendee vetting, as decided in [ticket #10](https://github.com/fvckzest/HP-OS/issues/10).
- Orders with the same purchase email on one Site are associated with one **Buyer**, while each Order retains the name and email entered for that purchase. A verified delivery-address correction re-associates the Order with the Buyer record for the corrected email on that Site. The same email on another Site does not join the records.
- A private **Access Request** is separate from an **Order**. An approved request permits checkout, which begins an Order.
- Multiple independent private **Access Requests** for one Event may use identical attendee names and emails. Each requires its own approval and permits one paid Ticket. There is no attendee-name or email uniqueness restriction per Event; this keeps repeated requests simple, as decided in [ticket #10](https://github.com/fvckzest/HP-OS/issues/10).
