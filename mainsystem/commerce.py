"""Inventory and a versioned shopping cart built on the specialist coordinator."""
import asyncio
import copy
import time
import uuid
from .agents import Tool, object_schema
from .catalog import CATALOG


class ShopWorkflows:
    def _init_shop(self):
        self.recorded_stock = {sku: item["recorded_stock"] for sku, item in CATALOG.items()}
        self.stock_checks = {}
        self.stock_versions = {sku: 0 for sku in CATALOG}
        self.restock_requests = []
        self.completed_checkouts = {}
        self.cart_lock = asyncio.Lock()
        self.cart = self._empty_cart()

    def _empty_cart(self, version=1, budget_cents=5000):
        return {"id": uuid.uuid4().hex, "version": version, "status": "open",
                "budget_cents": budget_cents, "items": {}, "checks": [], "issues": [],
                "checkout_id": None, "approval_expires_at": None}

    def cart_snapshot(self):
        result = copy.deepcopy(self.cart)
        result["lines"] = [{"sku": sku, "name": CATALOG[sku]["name"], "quantity": quantity,
                            "unit_price_cents": CATALOG[sku]["price_cents"],
                            "line_total_cents": CATALOG[sku]["price_cents"] * quantity}
                           for sku, quantity in result.pop("items").items()]
        result["subtotal_cents"] = sum(line["line_total_cents"] for line in result["lines"])
        result["money_mode"] = "test-ledger"
        return result

    def stock_snapshot(self):
        result = {}
        for sku, item in CATALOG.items():
            check = self.stock_checks.get(sku, {})
            evidence = check.get("evidence", {})
            quantity = evidence.get("quantity")
            result[sku] = {"recorded_quantity": self.recorded_stock[sku],
                "observed_quantity": quantity, "checked_at": evidence.get("observed_at"),
                "available": check.get("available"), "evidence": copy.deepcopy(evidence),
                "observation_stale": not self.fresh(evidence),
                "low_stock": (quantity if type(quantity) is int else self.recorded_stock[sku]) <= item["reorder_point"]}
        return result

    def invalidate_stock(self, sku, reason="Stock changed. Check the cart again before approval."):
        self.stock_versions[sku] += 1
        if sku in self.stock_checks:
            self.stock_checks[sku]["evidence"]["invalidated_by_sensor"] = True
        if sku in self.cart["items"] and self.cart["status"] in {"checking", "awaiting_approval", "fulfilling"}:
            self.cart.update(status="manual_review" if self.cart["status"] == "fulfilling" else "needs_changes",
                             version=self.cart["version"] + 1, checkout_id=None, approval_expires_at=None,
                             issues=[reason])
        for order in self.orders.values():
            if order["sku"] == sku and order["status"] == "awaiting_approval":
                order.get("inventory", {}).get("evidence", {})["invalidated_by_sensor"] = True

    def _cart_version(self, expected_version, edit=False):
        if self.stopped: raise RuntimeError("Emergency stop is active")
        if type(expected_version) is not int or expected_version != self.cart["version"]:
            raise ValueError("Cart changed. Review the current cart and try again.")
        if self.cart["status"] in {"checking", "fulfilling", "manual_review"}:
            raise ValueError("Cart is busy or requires manual review.")

    def _cart_changed(self):
        for key in ("quote", "receipt", "ledger"): self.cart.pop(key, None)
        self.cart.update(version=self.cart["version"] + 1, status="open", checks=[], issues=[],
                         checkout_id=None, approval_expires_at=None)
        self.emit("customer", "cart_updated", self.cart["id"], self.cart_snapshot())
        return self.cart_snapshot()

    async def set_cart_item(self, sku, quantity, expected_version):
        if sku not in CATALOG: raise ValueError("Unknown SKU")
        if type(quantity) is not int or not 0 <= quantity <= 20: raise ValueError("Quantity must be 0 to 20; zero removes the item")
        self._cart_version(expected_version, edit=True)
        items = {} if self.cart["status"] == "fulfilled" else self.cart["items"]
        if sum(items.values()) - items.get(sku, 0) + quantity > 50:
            raise ValueError("The demo cart supports at most 50 units")
        if items.get(sku, 0) == quantity: return self.cart_snapshot()
        if self.cart["status"] == "fulfilled":
            self.cart = self._empty_cart(self.cart["version"], self.cart["budget_cents"])
        if quantity: self.cart["items"][sku] = quantity
        else: self.cart["items"].pop(sku, None)
        return self._cart_changed()

    async def set_cart_budget(self, budget_cents, expected_version):
        if type(budget_cents) is not int or not 1 <= budget_cents <= 1000000: raise ValueError("Invalid budget")
        self._cart_version(expected_version, edit=True)
        if self.cart["budget_cents"] == budget_cents: return self.cart_snapshot()
        if self.cart["status"] == "fulfilled":
            self.cart = self._empty_cart(self.cart["version"], self.cart["budget_cents"])
        self.cart["budget_cents"] = budget_cents
        return self._cart_changed()

    async def clear_cart(self, expected_version):
        self._cart_version(expected_version)
        self.cart = self._empty_cart(self.cart["version"], self.cart["budget_cents"])
        return self._cart_changed()

    async def check_stock(self, sku):
        if sku != "all" and sku not in CATALOG: raise ValueError("Unknown SKU")
        if self.stopped: raise RuntimeError("Emergency stop is active")
        selected = list(CATALOG) if sku == "all" else [sku]
        mission = uuid.uuid4().hex
        checks = await asyncio.gather(*(self._inventory(item, mission) for item in selected))
        return {"status": "checked", "device_mode": self.device.mode,
                "items": {item: result for item, result in zip(selected, checks)}}

    async def restock_item(self, sku, quantity):
        if sku not in CATALOG: raise ValueError("Unknown SKU")
        if type(quantity) is not int or not 1 <= quantity <= 100: raise ValueError("Restock quantity must be 1 to 100")
        if self.stopped: raise RuntimeError("Emergency stop is active")
        request = {"id": uuid.uuid4().hex, "sku": sku, "quantity": quantity,
                   "requested_at": time.time(), "device_mode": self.device.mode}
        if self.device.mode != "simulated":
            request.update(status="requested", stock_changed=False,
                           next_step="Physically restock the shelf, then check stock. No hardware restock was performed.")
        else:
            async with self.robot_lock:
                if self.stopped: raise RuntimeError("Emergency stop is active")
                evidence = await self.device.restock(sku, quantity)
            self.invalidate_stock(sku, "Stock was restocked. Check the cart again before approval.")
            self.recorded_stock[sku] = evidence["quantity"]
            self.stock_checks[sku] = {"sku": sku, "available": evidence["present"], "mismatch": False, "evidence": evidence}
            request.update(status="restocked", stock_changed=True, evidence=evidence)
        self.restock_requests.append(request)
        self.emit("inventory", "restock_" + request["status"], request["id"], request)
        return copy.deepcopy(request)

    @staticmethod
    def _enough(evidence, quantity):
        if evidence.get("present") is not True: return False
        count = evidence.get("quantity")
        if "quantity" in evidence and (type(count) is not int or count < 0): return False
        # Presence-only hardware can verify one unit, never an arbitrary quantity.
        return count >= quantity if type(count) is int else quantity == 1

    async def check_cart(self, expected_version):
        self._cart_version(expected_version)
        if self.cart["status"] == "fulfilled": raise ValueError("This cart is already fulfilled. Start a new cart.")
        if not self.cart["items"]: raise ValueError("Add items to the cart first")
        self.cart.update(status="checking", version=self.cart["version"] + 1, issues=[], checks=[],
                         checkout_id=None, approval_expires_at=None)
        checking_version = self.cart["version"]
        cart_id, budget = self.cart["id"], self.cart["budget_cents"]
        items = copy.deepcopy(self.cart["items"])

        async def quote_cart(cart_id, budget_cents):
            if cart_id != self.cart["id"] or budget_cents != budget: raise ValueError("Cart quote terms changed")
            total = sum(CATALOG[sku]["price_cents"] * quantity for sku, quantity in items.items())
            return {"subtotal_cents": total, "budget_cents": budget, "within_budget": total <= budget,
                    "currency": "USD", "money_mode": "test-ledger"}
        try:
            async with asyncio.TaskGroup() as group:
                checks = {sku: group.create_task(self._inventory(sku, cart_id)) for sku in items}
                finance = group.create_task(self.agents["finance"].run(cart_id,
                    {"cart_id": cart_id, "budget_cents": budget}, [Tool("quote_cart",
                     "Quote the exact current basket and check the total against its budget",
                     object_schema({"cart_id": {"type": "string"}, "budget_cents": {"type": "integer", "minimum": 1}}), quote_cart)]))
            if self.cart["version"] != checking_version or self.cart["status"] != "checking" or self.stopped:
                raise ValueError("Cart or stock changed during inspection. Check it again.")
            quote = finance.result()[-1]["result"]
            results, issues = [], []
            if not quote["within_budget"]: issues.append("Cart total exceeds the budget. Remove items or increase the budget.")
            for sku, task in checks.items():
                evidence = task.result()["evidence"]
                enough = self._enough(evidence, items[sku]) and self.fresh(evidence)
                eligibility = self.batch_eligibility(sku, items[sku], evidence)
                enough = enough and eligibility["eligible"]
                results.append({"sku": sku, "requested_quantity": items[sku], "available_quantity": evidence.get("quantity"),
                                "enough_stock": enough, "evidence": evidence, "batch_eligibility": eligibility})
                issues.extend(eligibility["issues"])
                if not enough: issues.append(f"Not enough verified stock for {CATALOG[sku]['name']}; restock or reduce its quantity.")
            self.cart.update(status="needs_changes" if issues else "awaiting_approval", checks=results, issues=issues,
                             quote=quote, version=self.cart["version"] + 1,
                             checkout_id=None if issues else uuid.uuid4().hex,
                             approval_expires_at=None if issues else min(r["evidence"]["observed_at"] for r in results) + self.max_age)
            self.emit("coordinator", "cart_checked", cart_id, self.cart_snapshot())
            return self.cart_snapshot()
        except Exception:
            if self.cart["version"] == checking_version:
                self.cart.update(status="needs_changes", version=self.cart["version"] + 1,
                                 issues=["Cart inspection failed. Check stock and try again."])
            raise

    async def approve_cart(self, expected_version, checkout_id):
        if type(expected_version) is not int or not isinstance(checkout_id, str):
            raise ValueError("A checkout ID and integer cart version are required")
        async with self.cart_lock:
            previous = self.completed_checkouts.get(checkout_id)
            if previous and previous["approved_version"] == expected_version: return copy.deepcopy(previous["cart"])
            self._cart_version(expected_version)
            if not checkout_id or checkout_id != self.cart["checkout_id"] or self.cart["status"] != "awaiting_approval":
                raise ValueError("Cart is not ready for approval. Check it again.")
            if not all(self.fresh(check["evidence"]) for check in self.cart["checks"]):
                self.cart.update(status="needs_changes", version=self.cart["version"] + 1, checkout_id=None,
                                 approval_expires_at=None, issues=["Inspection expired. Check the cart again."])
                raise ValueError("Inspection expired. Check the cart again.")
            if not self.cart["quote"]["within_budget"]: raise ValueError("Cart total exceeds the budget")
            for check in self.cart["checks"]:
                self.require_batch_eligibility(check["sku"], check["requested_quantity"], check["evidence"])
            items, total = copy.deepcopy(self.cart["items"]), self.cart["quote"]["subtotal_cents"]
            self.cart.update(status="fulfilling", version=self.cart["version"] + 1)
            fulfillment_version = self.cart["version"]
            self.emit("human", "cart_approved", self.cart["id"], {"checkout_id": checkout_id, "items": items, "total_cents": total})
            receipts = []
            executed = None

            def still_allowed():
                if self.stopped or self.cart["version"] != fulfillment_version or self.cart["status"] != "fulfilling":
                    raise RuntimeError("Checkout interrupted by a stop or changed stock")

            async def deliver_cart(checkout_id):
                nonlocal executed
                if checkout_id != self.cart["checkout_id"]: raise ValueError("Checkout target changed")
                if executed is not None: return executed
                async with self.robot_lock:
                    still_allowed()
                    # Verify the entire basket before moving its first item.
                    for sku, quantity in items.items():
                        evidence = await asyncio.wait_for(self.device.inspect(sku), timeout=7)
                        still_allowed()
                        if evidence.get("sku") != sku or not self.fresh(evidence) or not self._enough(evidence, quantity):
                            raise RuntimeError("Stock changed before checkout delivery")
                        self.require_batch_eligibility(sku, quantity, evidence)
                    for sku, quantity in items.items():
                        for unit in range(quantity):
                            still_allowed()
                            command_id = f"{checkout_id}:{sku}:{unit}"
                            receipt = await asyncio.wait_for(self.device.deliver(sku, command_id), timeout=7)
                            if (not self.fresh(receipt) or receipt.get("completed") is not True
                                    or receipt.get("arrival_verified") is not True or receipt.get("sku") != sku
                                    or receipt.get("command_id") != command_id):
                                raise RuntimeError("Delivery completion is unverified; reconcile manually")
                            receipts.append(receipt)
                            self.sustainability.consume(sku, receipt)
                            self.recorded_stock[sku] = max(0, self.recorded_stock[sku] - 1)
                            self.stock_checks.pop(sku, None)
                            self.stock_versions[sku] += 1
                            for order in self.orders.values():
                                if order["sku"] == sku and order["status"] == "awaiting_approval":
                                    order.get("inventory", {}).get("evidence", {})["invalidated_by_sensor"] = True
                            still_allowed()
                    executed = {"checkout_id": checkout_id, "completed": True, "receipts": receipts}
                    return executed
            try:
                await self.agents["robot"].run(self.cart["id"], {"checkout_id": checkout_id}, [Tool(
                    "deliver_cart", "Deliver only the exact human-approved basket; verify stock and every arrival",
                    object_schema({"checkout_id": {"type": "string"}}), deliver_cart)])
                if executed is None: raise RuntimeError("No delivery evidence returned")
                still_allowed()
                self.cart.update(status="fulfilled", version=self.cart["version"] + 1, receipt=executed,
                    ledger={"recognized_test_revenue_cents": total, "reconciled": True})
                result = self.cart_snapshot()
                self.completed_checkouts[checkout_id] = {"approved_version": expected_version, "cart": result}
                self.emit("finance", "cart_reconciled", self.cart["id"], result["ledger"])
                return result
            except Exception:
                self.cart.update(status="manual_review", version=self.cart["version"] + 1,
                    issues=["Checkout did not finish. Reconcile the verified receipts before another delivery."],
                    receipt={"checkout_id": checkout_id, "completed": False, "receipts": receipts},
                    ledger={"recognized_test_revenue_cents": 0, "reconciled": False})
                self.emit("coordinator", "cart_manual_review", self.cart["id"], self.cart_snapshot())
                raise
