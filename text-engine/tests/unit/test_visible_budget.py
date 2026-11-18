import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'runtime'))
from request_defaults import apply_defaults


class VisibleBudget(unittest.TestCase):
    def test_both_limit_fields_reserve_thinking_and_limit_visible_output(self):
        for key in ('max_tokens', 'max_completion_tokens'):
            data = apply_defaults({key: 2000}, True)
            self.assertEqual(data[key], 2000)
            self.assertEqual(data['vllm_xargs']['b70_visible_tokens'], 2000)
            self.assertIn('<tool_call>', data['bad_words'])

    def test_standard_total_nonreasoning_and_absent_limit(self):
        for data, active in [({'max_tokens': 32}, False),
                             ({'max_tokens': 32, 'reasoning_effort': 'none'}, True),
                             ({'max_tokens': 32, 'thinking_token_budget': 0}, True),
                             ({}, True)]:
            expected = data.get('max_tokens', 16384)
            result = apply_defaults(data, active)
            self.assertEqual(result['max_tokens'], expected)
            self.assertNotIn('vllm_xargs', result)

    def test_unmarked_chat_cannot_inject_internal_allowance(self):
        data = apply_defaults({'max_tokens': 16, 'vllm_xargs': {'b70_visible_tokens': 16, 'other': 1}})
        self.assertEqual(data['vllm_xargs'], {'other': 1})

    def test_explicit_thinking_limit_and_tool_requests(self):
        data = apply_defaults({'max_completion_tokens': 24, 'thinking_token_budget': 120,
                               'tools': [{'type': 'function'}], 'vllm_xargs': {'example': 3}}, True)
        self.assertEqual(data['max_completion_tokens'], 24)
        self.assertNotIn('bad_words', data)
        self.assertEqual(data['vllm_xargs']['example'], 3)
