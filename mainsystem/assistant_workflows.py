"""Mel supervision and reviewable operator records on the Swarm event loop."""
import asyncio
import copy
import json
import os
import time
import uuid

from .agents import Tool
from .catalog import CATALOG
from .filter_lifecycle import FilterLifecycleStore
from .proposals import ProposalStore
from .providers import MelProvider
from .supervisor import MelSupervisor
from .voice import PROPOSAL_HELP, tool_configs


class AssistantWorkflows:
    def _init_assistant(self):
        self.water_filters = FilterLifecycleStore(self.db, self.session_id, self.device.mode)
        self.operator_proposals = ProposalStore(self.db, self.session_id, self.device.mode)
        self.mel_requests = {}
        self.mel_supervisor = None
        self.mel_status = {"provider": "mel", "status": "not_configured", "configured": False,
                           "authenticated": False, "message": "Connect Mel with mel-login to enable voice and text orchestration."}
        if os.getenv("MEL_TOKEN") and os.getenv("MEL_RELAY_URL"):
            try:
                self.mel_supervisor = MelSupervisor(MelProvider(tool_role="orchestrator"), self._mel_tools, self.emit)
                self.mel_status.update(status="configured_unverified", configured=True,
                    message="Mel credentials configured; the next request verifies the connection.")
            except Exception:
                self.mel_status.update(status="configuration_error", message="Mel configuration is invalid. Check the relay URL and sign-in.")

    def _mel_tools(self):
        tools = []
        for config in tool_configs():
            async def invoke(name=config["name"], **params):
                return await self.invoke_workflow_tool(name, params)
            tools.append(Tool(config["name"], config["description"], config["parameters"], invoke))
        return tools

    async def invoke_workflow_tool(self, name, params):
        if name == "catalog":
            return {"catalog": {sku: {**item, "recorded_stock": self.recorded_stock[sku]} for sku, item in CATALOG.items()},
                    "provider": self.provider.name, "supervisor": copy.deepcopy(self.mel_status),
                    "device_mode": self.device.mode, "money_mode": "test-ledger"}
        if name == "inventory_status":
            return {"stock": self.stock_snapshot(), "units": {sku: item["unit"] for sku, item in CATALOG.items()},
                    "device_mode": self.device.mode, "instruction": "Use check_stock for a fresh observed count."}
        if name == "view_cart": return self.cart_snapshot()
        if name == "order_status": return copy.deepcopy(self.orders.get(params["order_id"], {"error": "Unknown order"}))
        if name == "job_status":
            job = self.jobs.get(params["job_id"])
            # Never return another supervisor's transcript as workflow evidence.
            if not job or job.get("operation") == "mel_supervisor": return {"error": "Unknown workflow job"}
            # Let independent specialists finish without spending a new Mel
            # model leg every second. This yields to their event-loop tasks.
            loop = asyncio.get_running_loop()
            deadline = loop.time() + 3
            while job["status"] == "running":
                remaining = deadline - loop.time()
                if remaining <= 0: break
                await asyncio.sleep(min(.2, remaining))
            return copy.deepcopy(job)
        if name == "request_approval":
            return {"order": copy.deepcopy(self.orders.get(params["order_id"], {"error": "Unknown order"})),
                    "approval_granted": False, "next_step": "Human operator must approve this exact order in the console."}
        if name == "request_checkout_approval":
            return {"cart": self.cart_snapshot(), "approval_granted": False,
                    "next_step": "Human operator must approve the exact checked cart in the console."}
        jobs = {"prepare_order": "prepare", "check_stock": "check_stock", "restock_item": "restock", "check_cart": "check_cart"}
        if name in jobs: return await self.start_job(jobs[name], **params)
        if name == "set_cart_item": return await self.set_cart_item(**params)
        if name == "set_cart_budget": return await self.set_cart_budget(**params)
        if name == "clear_cart": return await self.clear_cart(**params)
        if name == "emergency_stop": return await self.stop()
        if name == "water_filter_status": return self.water_filters.snapshot()
        if name == "operator_tasks":
            return {"proposals": self.operator_proposals.snapshot(), "workflow_fields": PROPOSAL_HELP,
                    "approval": "Only the human operator can apply or reject these proposals in the console."}
        if name == "propose_action":
            return await self.propose_action({"request_id": params["request_id"], "operation": params["operation"],
                "details": json.loads(params["details_json"]), "reason": params["reason"]})
        fields = {"environment_status": ("environment",), "waste_risk": ("batches", "actions", "reconciliation"),
                  "restock_plan": ("plans",), "impact_summary": ("impact", "outcomes", "refills")}
        if name in fields:
            state = self.sustainability_snapshot()
            result = {"available": True, "device_mode": self.device.mode, **{key: state[key] for key in fields[name]}}
            if name == "waste_risk":
                result["historical_batch_count"] = sum(batch.get("active") is False for batch in result["batches"])
                result["batches"] = [batch for batch in result["batches"] if batch.get("active") is not False and batch["remaining_units"] > 0]
            return result
        raise ValueError("Workflow tool is not allowed")

    async def start_mel_request(self, request, request_id, conversation_id):
        for value, label, maximum in [(request, "request", 4000), (request_id, "request_id", 128), (conversation_id, "conversation_id", 128)]:
            if not isinstance(value, str) or not value.strip() or len(value) > maximum:
                raise ValueError("Invalid " + label)
        key = (conversation_id, request_id)
        if key in self.mel_requests:
            previous = self.mel_requests[key]
            if previous["request"] != request: raise ValueError("Request ID was already used for different content")
            job = self.jobs[previous["job_id"]]
            return {"job_id": job["id"], "status": job["status"], "conversation_id": conversation_id}
        if self.mel_supervisor is None:
            raise ValueError("Mel supervisor is not configured. Complete mel-login and restart the backend; no scripted fallback is used.")
        if sum(job["status"] == "running" and job.get("operation") == "mel_supervisor" for job in self.jobs.values()) >= 2:
            raise ValueError("Mel is handling two requests already; wait for a result")
        if len(self.mel_requests) >= 500: raise ValueError("Session request limit reached; finish current work before restarting")
        job_id = uuid.uuid4().hex
        self.mel_requests[key] = {"request": request, "job_id": job_id}
        self.jobs[job_id] = {"id": job_id, "operation": "mel_supervisor", "status": "running",
                             "request": request, "conversation_id": conversation_id, "created_at": time.time()}
        self.emit("mel", "request_received", job_id, {"request": request, "conversation_id": conversation_id})
        async def run():
            try:
                result = await asyncio.wait_for(self.mel_supervisor.run(request, conversation_id), timeout=180)
                self.jobs[job_id].update(status="completed", result=result)
                live_mel = result.get("provider") == "mel"
                self.mel_status.update(status="ready" if live_mel else "test_fixture", authenticated=live_mel,
                    message="Mel has completed a tool-backed request." if live_mel else "An explicit offline supervisor fixture completed this test request.")
                self.emit("mel", "answer_ready", job_id, {"answer": result["answer"], "tool_count": result.get("tool_count")})
            except asyncio.CancelledError:
                self.jobs[job_id].update(status="failed", error="Request cancelled. Review tool activity before retrying changes.")
                raise
            except Exception as error:
                message = "Mel request failed (" + type(error).__name__ + "). Review tool activity before retrying; no scripted fallback ran."
                self.jobs[job_id].update(status="failed", error=message)
                self.mel_status.update(status="error", message=message)
                self.emit("mel", "request_failed", job_id, {"error_type": type(error).__name__})
        asyncio.create_task(run())
        return {"job_id": job_id, "status": "running", "conversation_id": conversation_id,
                "instruction": "Poll this request. Only its completed answer is Mel's result."}

    async def propose_action(self, body):
        if self.stopped: raise ValueError("Emergency stop is active")
        result = self.operator_proposals.create(body)
        self.emit("mel", "operator_review_requested", result["proposal_id"], {"operation": result["operation"], "status": result["status"]})
        return result

    async def filter_action(self, operation, body):
        if self.stopped: raise ValueError("Emergency stop is active")
        actions = {"filter_register": self.water_filters.register, "filter_throughput": self.water_filters.record_throughput}
        if operation not in actions: raise ValueError("Unknown filter action")
        result = actions[operation](body)
        self.emit("operator", operation, result.get("filter_id"), result)
        return result

    async def review_proposal(self, proposal_id, decision, retry=False):
        if type(retry) is not bool: raise ValueError("retry must be boolean")
        if self.stopped: raise ValueError("Emergency stop is active")
        if decision == "reject": result = self.operator_proposals.reject(proposal_id, "Rejected in the operator console")
        elif decision == "apply":
            async def apply(operation, body):
                if operation.startswith("filter_"): return await self.filter_action(operation, body)
                return await self.sustainability_action(operation, body)
            result = await self.operator_proposals.apply(proposal_id, apply, retry=retry)
        else: raise ValueError("Unknown proposal decision")
        self.emit("operator", "proposal_" + decision, proposal_id, {"status": result["status"]})
        return result
